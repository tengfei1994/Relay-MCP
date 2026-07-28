using Microsoft.Win32;
using System;
using System.Collections.Generic;
using System.Data;
using System.Data.SqlClient;
using System.Linq;

namespace RelayAgent.Client
{
    public enum DatabaseAccessLevel
    {
        Read,
        ReadWrite,
        Ddl
    }

    public sealed class DatabaseCandidate
    {
        public string Name { get; set; }
        public bool LooksLikeSampleManager { get; set; }

        public override string ToString()
        {
            return LooksLikeSampleManager ? Name + "  (SampleManager)" : Name;
        }
    }

    public sealed class DatabasePermissionState
    {
        public string Server { get; set; }
        public string Database { get; set; }
        public string ServiceIdentity { get; set; }
        public bool LoginExists { get; set; }
        public bool UserExists { get; set; }
        public bool CanRead { get; set; }
        public bool CanWrite { get; set; }
        public bool CanChangeSchema { get; set; }
        public bool CanViewDefinition { get; set; }

        public bool ReadReady
        {
            get { return LoginExists && UserExists && CanRead && CanViewDefinition; }
        }
    }

    public static class DatabaseAccessManager
    {
        public static IList<string> DiscoverLocalServers()
        {
            var servers = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                "localhost"
            };

            using (var services = Registry.LocalMachine.OpenSubKey(
                @"SYSTEM\CurrentControlSet\Services"))
            {
                if (services == null)
                {
                    return servers.OrderBy(value => value).ToList();
                }

                foreach (var serviceName in services.GetSubKeyNames())
                {
                    if (serviceName.StartsWith("MSSQL$", StringComparison.OrdinalIgnoreCase))
                    {
                        var instance = serviceName.Substring("MSSQL$".Length);
                        if (!string.IsNullOrWhiteSpace(instance))
                        {
                            servers.Add(@"localhost\" + instance);
                        }
                    }
                    else if (serviceName.Equals("MSSQLSERVER", StringComparison.OrdinalIgnoreCase))
                    {
                        servers.Add("localhost");
                    }
                }
            }

            return servers.OrderBy(value => value).ToList();
        }

        public static string GetServiceIdentity()
        {
            using (var key = Registry.LocalMachine.OpenSubKey(
                @"SYSTEM\CurrentControlSet\Services\RelayMcpAgent"))
            {
                var objectName = key == null ? null : key.GetValue("ObjectName") as string;
                if (string.IsNullOrWhiteSpace(objectName) ||
                    objectName.Equals("LocalSystem", StringComparison.OrdinalIgnoreCase))
                {
                    return @"NT AUTHORITY\SYSTEM";
                }
                return objectName;
            }
        }

        public static IList<DatabaseCandidate> DiscoverDatabases(string server)
        {
            var databases = new List<DatabaseCandidate>();
            using (var connection = Open(server, "master"))
            using (var command = connection.CreateCommand())
            {
                command.CommandText = @"
SELECT [name]
FROM sys.databases
WHERE database_id > 4
  AND state = 0
  AND source_database_id IS NULL
ORDER BY [name];";

                using (var reader = command.ExecuteReader())
                {
                    while (reader.Read())
                    {
                        databases.Add(new DatabaseCandidate
                        {
                            Name = reader.GetString(0)
                        });
                    }
                }
            }

            foreach (var database in databases)
            {
                try
                {
                    using (var connection = Open(server, database.Name))
                    using (var command = connection.CreateCommand())
                    {
                        command.CommandText = @"
SELECT CASE WHEN
    OBJECT_ID(N'dbo.MASTER_MENU', N'U') IS NOT NULL OR
    OBJECT_ID(N'dbo.PERSONNEL', N'U') IS NOT NULL OR
    OBJECT_ID(N'dbo.VERSION_INFO', N'U') IS NOT NULL OR
    OBJECT_ID(N'dbo.LAB_EXECUTION', N'U') IS NOT NULL
THEN 1 ELSE 0 END;";
                        database.LooksLikeSampleManager = Convert.ToInt32(command.ExecuteScalar()) == 1;
                    }
                }
                catch
                {
                    database.LooksLikeSampleManager = false;
                }
            }

            return databases
                .OrderByDescending(item => item.LooksLikeSampleManager)
                .ThenBy(item => item.Name)
                .ToList();
        }

        public static DatabasePermissionState Test(
            string server,
            string database,
            string serviceIdentity)
        {
            ValidateTarget(server, database, serviceIdentity);
            var state = new DatabasePermissionState
            {
                Server = server,
                Database = database,
                ServiceIdentity = serviceIdentity
            };

            using (var connection = Open(server, "master"))
            using (var command = connection.CreateCommand())
            {
                command.CommandText = @"
SELECT COUNT(*)
FROM sys.server_principals
WHERE [name] = @identity
  AND [type] IN (N'U', N'G');";
                command.Parameters.Add("@identity", SqlDbType.NVarChar, 256).Value = serviceIdentity;
                state.LoginExists = Convert.ToInt32(command.ExecuteScalar()) > 0;
            }

            using (var connection = Open(server, database))
            {
                state.UserExists = ExecuteBoolean(connection, @"
SELECT COUNT(*)
FROM sys.database_principals
WHERE [name] = @identity;", serviceIdentity);

                state.CanRead = IsRoleMember(connection, "db_datareader", serviceIdentity);
                state.CanWrite = IsRoleMember(connection, "db_datawriter", serviceIdentity);
                state.CanChangeSchema = IsRoleMember(connection, "db_ddladmin", serviceIdentity);
                state.CanViewDefinition = ExecuteBoolean(connection, @"
SELECT COUNT(*)
FROM sys.database_permissions permission
JOIN sys.database_principals principal
  ON principal.principal_id = permission.grantee_principal_id
WHERE principal.[name] = @identity
  AND permission.permission_name = N'VIEW DEFINITION'
  AND permission.state IN (N'G', N'W');", serviceIdentity);
            }

            return state;
        }

        public static DatabasePermissionState Grant(
            string server,
            string database,
            string serviceIdentity,
            DatabaseAccessLevel level)
        {
            ValidateTarget(server, database, serviceIdentity);
            var quotedIdentity = QuoteIdentifier(serviceIdentity);
            var quotedDatabase = QuoteIdentifier(database);

            using (var connection = Open(server, "master"))
            using (var command = connection.CreateCommand())
            {
                command.CommandText = @"
IF SUSER_ID(@identity) IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM sys.server_principals
    WHERE [name] = @identity
      AND [type] IN (N'U', N'G')
)
BEGIN
    RAISERROR(N'An existing non-Windows login uses the requested service identity name.', 16, 1);
    RETURN;
END;

IF SUSER_ID(@identity) IS NULL
BEGIN
    EXEC(N'CREATE LOGIN " + quotedIdentity + @" FROM WINDOWS');
END;
EXEC(N'GRANT VIEW ANY DATABASE TO " + quotedIdentity + @"');";
                command.Parameters.Add("@identity", SqlDbType.NVarChar, 256).Value = serviceIdentity;
                command.ExecuteNonQuery();
            }

            using (var connection = Open(server, database))
            using (var command = connection.CreateCommand())
            {
                var script = @"
IF DATABASE_PRINCIPAL_ID(@identity) IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM sys.database_principals
    WHERE [name] = @identity
      AND [sid] = SUSER_SID(@identity)
)
BEGIN
    RAISERROR(N'An existing database user with this name maps to a different login.', 16, 1);
    RETURN;
END;

IF DATABASE_PRINCIPAL_ID(@identity) IS NULL
BEGIN
    EXEC(N'CREATE USER " + quotedIdentity + @" FOR LOGIN " + quotedIdentity + @"');
END;

IF NOT EXISTS (
    SELECT 1
    FROM sys.database_role_members drm
    JOIN sys.database_principals rolep ON rolep.principal_id = drm.role_principal_id
    JOIN sys.database_principals memberp ON memberp.principal_id = drm.member_principal_id
    WHERE rolep.[name] = N'db_datareader' AND memberp.[name] = @identity
)
    EXEC(N'ALTER ROLE [db_datareader] ADD MEMBER " + quotedIdentity + @"');

EXEC(N'GRANT VIEW DEFINITION TO " + quotedIdentity + @"');";

                if (level == DatabaseAccessLevel.ReadWrite || level == DatabaseAccessLevel.Ddl)
                {
                    script += @"

IF NOT EXISTS (
    SELECT 1
    FROM sys.database_role_members drm
    JOIN sys.database_principals rolep ON rolep.principal_id = drm.role_principal_id
    JOIN sys.database_principals memberp ON memberp.principal_id = drm.member_principal_id
    WHERE rolep.[name] = N'db_datawriter' AND memberp.[name] = @identity
)
    EXEC(N'ALTER ROLE [db_datawriter] ADD MEMBER " + quotedIdentity + @"');";
                }

                if (level == DatabaseAccessLevel.Ddl)
                {
                    script += @"

IF NOT EXISTS (
    SELECT 1
    FROM sys.database_role_members drm
    JOIN sys.database_principals rolep ON rolep.principal_id = drm.role_principal_id
    JOIN sys.database_principals memberp ON memberp.principal_id = drm.member_principal_id
    WHERE rolep.[name] = N'db_ddladmin' AND memberp.[name] = @identity
)
    EXEC(N'ALTER ROLE [db_ddladmin] ADD MEMBER " + quotedIdentity + @"');";
                }

                command.CommandText = "USE " + quotedDatabase + ";" + script;
                command.Parameters.Add("@identity", SqlDbType.NVarChar, 256).Value = serviceIdentity;
                command.ExecuteNonQuery();
            }

            return Test(server, database, serviceIdentity);
        }

        public static DatabasePermissionState RevokeDatabaseAccess(
            string server,
            string database,
            string serviceIdentity)
        {
            ValidateTarget(server, database, serviceIdentity);
            var quotedIdentity = QuoteIdentifier(serviceIdentity);
            using (var connection = Open(server, database))
            using (var command = connection.CreateCommand())
            {
                command.CommandText = @"
IF DATABASE_PRINCIPAL_ID(@identity) IS NOT NULL
BEGIN
    IF IS_ROLEMEMBER(N'db_ddladmin', @identity) = 1
        EXEC(N'ALTER ROLE [db_ddladmin] DROP MEMBER " + quotedIdentity + @"');
    IF IS_ROLEMEMBER(N'db_datawriter', @identity) = 1
        EXEC(N'ALTER ROLE [db_datawriter] DROP MEMBER " + quotedIdentity + @"');
    IF IS_ROLEMEMBER(N'db_datareader', @identity) = 1
        EXEC(N'ALTER ROLE [db_datareader] DROP MEMBER " + quotedIdentity + @"');
    EXEC(N'REVOKE VIEW DEFINITION TO " + quotedIdentity + @"');
    EXEC(N'DROP USER " + quotedIdentity + @"');
END;";
                command.Parameters.Add("@identity", SqlDbType.NVarChar, 256).Value = serviceIdentity;
                command.ExecuteNonQuery();
            }

            return Test(server, database, serviceIdentity);
        }

        private static SqlConnection Open(string server, string database)
        {
            if (string.IsNullOrWhiteSpace(server))
            {
                throw new InvalidOperationException("SQL Server is required.");
            }

            var builder = new SqlConnectionStringBuilder
            {
                DataSource = server.Trim(),
                InitialCatalog = database,
                IntegratedSecurity = true,
                TrustServerCertificate = true,
                ConnectTimeout = 10,
                ApplicationName = "Relay MCP Agent Client"
            };
            var connection = new SqlConnection(builder.ConnectionString);
            connection.Open();
            return connection;
        }

        private static bool ExecuteBoolean(
            SqlConnection connection,
            string sql,
            string identity)
        {
            using (var command = connection.CreateCommand())
            {
                command.CommandText = sql;
                command.Parameters.Add("@identity", SqlDbType.NVarChar, 256).Value = identity;
                return Convert.ToInt32(command.ExecuteScalar()) > 0;
            }
        }

        private static bool IsRoleMember(
            SqlConnection connection,
            string role,
            string identity)
        {
            using (var command = connection.CreateCommand())
            {
                command.CommandText = @"
SELECT COUNT(*)
FROM sys.database_role_members drm
JOIN sys.database_principals rolep ON rolep.principal_id = drm.role_principal_id
JOIN sys.database_principals memberp ON memberp.principal_id = drm.member_principal_id
WHERE rolep.[name] = @role AND memberp.[name] = @identity;";
                command.Parameters.Add("@role", SqlDbType.NVarChar, 128).Value = role;
                command.Parameters.Add("@identity", SqlDbType.NVarChar, 256).Value = identity;
                return Convert.ToInt32(command.ExecuteScalar()) > 0;
            }
        }

        private static void ValidateTarget(
            string server,
            string database,
            string identity)
        {
            if (string.IsNullOrWhiteSpace(server))
            {
                throw new InvalidOperationException("SQL Server is required.");
            }
            if (string.IsNullOrWhiteSpace(database))
            {
                throw new InvalidOperationException("Database is required.");
            }
            if (string.IsNullOrWhiteSpace(identity))
            {
                throw new InvalidOperationException("Windows service identity is required.");
            }
        }

        private static string QuoteIdentifier(string value)
        {
            return "[" + (value ?? "").Replace("]", "]]") + "]";
        }
    }
}
