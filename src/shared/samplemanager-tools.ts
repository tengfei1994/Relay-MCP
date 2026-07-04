import type { RemoteRunner } from "./remote-runner.js";
import { compactText } from "./output.js";

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function instancePaths(instance: string) {
  const root = `C:\\Thermo\\SampleManager\\Server\\${instance}`;
  return {
    root,
    exe: `${root}\\Exe`,
    formsBin: `${root}\\Exe\\FormsBin`,
    logfile: `${root}\\Logfile`,
    solutionAssemblies: `${root}\\Exe\\SolutionAssemblies`,
  };
}

export async function restartSampleManagerInstance(runner: RemoteRunner, instance: string): Promise<string> {
  const suffix = instance.toLowerCase();
  const script = `
$ErrorActionPreference = "Continue"
Get-Process SampleManagerServerHost -ErrorAction SilentlyContinue | Stop-Process -Force
$services = @('smptq${suffix}','smpSTAT${suffix}','smp${suffix}','SMDaemon${suffix}')
foreach ($svc in $services) {
  if (Get-Service $svc -ErrorAction SilentlyContinue) {
    Restart-Service $svc -Force
  }
}
Get-Service $services -ErrorAction SilentlyContinue | Select-Object Name,Status | Format-Table -AutoSize
`;
  const result = await runner.execPowerShell(script, 120000);
  return compactText(`${result.stdout}\n${result.stderr}`.trim());
}

export async function clearFormCache(runner: RemoteRunner, instance: string, formName: string): Promise<string> {
  const paths = instancePaths(instance);
  const script = `
$ErrorActionPreference = "Continue"
$formsBin = ${psQuote(paths.formsBin)}
$formName = ${psQuote(formName)}
$removed = @()
if (Test-Path -LiteralPath $formsBin) {
  Get-ChildItem -LiteralPath $formsBin -File -Filter "$formName*" -ErrorAction SilentlyContinue | ForEach-Object {
    $removed += $_.FullName
    Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
  }
}
[pscustomobject]@{ Instance=${psQuote(instance)}; Form=$formName; Removed=$removed } | ConvertTo-Json -Compress
`;
  const result = await runner.execPowerShell(script, 30000);
  return compactText(result.stdout || result.stderr);
}

export async function recentErrors(
  runner: RemoteRunner,
  instance: string,
  minutes = 30,
  keywords: string[] = ["ERROR", "Exception", "NewPharma", "SampleManager"]
): Promise<string> {
  const paths = instancePaths(instance);
  const pattern = keywords.join("|");
  const script = `
$ErrorActionPreference = "Continue"
$since = (Get-Date).AddMinutes(-${minutes})
$root = ${psQuote(paths.logfile)}
$pattern = ${psQuote(pattern)}
$matches = @()
if (Test-Path -LiteralPath $root) {
  Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -ge $since -and ($_.Extension -in '.log','.txt','.lis' -or $_.Name -like '*log*') } |
    ForEach-Object {
      Select-String -LiteralPath $_.FullName -Pattern $pattern -ErrorAction SilentlyContinue |
        Select-Object -Last 20 |
        ForEach-Object {
          $matches += [pscustomobject]@{ file=$_.Path; line=$_.LineNumber; text=$_.Line }
        }
    }
}
$matches | Select-Object -Last 80 | ConvertTo-Json -Compress
`;
  const result = await runner.execPowerShell(script, 60000);
  return compactText(result.stdout || result.stderr);
}

export async function runSql(
  runner: RemoteRunner,
  database: string,
  sql: string,
  allowMutation = false
): Promise<string> {
  const mutationPattern = /\b(insert|update|delete|merge|drop|alter|truncate|create|exec|execute)\b/i;
  if (!allowMutation && mutationPattern.test(sql)) {
    throw new Error("SQL appears to mutate data. Pass allowMutation=true only inside an approved workflow.");
  }
  const safeDatabase = database.replace(/"/g, '""');
  const safeSql = sql.replace(/'@/g, "' + '@' + '");
  const script = `
$ErrorActionPreference = "Stop"
$cs = "Server=localhost;Database=${safeDatabase};Integrated Security=True;TrustServerCertificate=True"
$cn = New-Object System.Data.SqlClient.SqlConnection $cs
$cn.Open()
try {
  $cmd = $cn.CreateCommand()
  $cmd.CommandTimeout = 120
$cmd.CommandText = @'
${safeSql}
'@
  $reader = $cmd.ExecuteReader()
  $resultSets = @()
  do {
    $schema = $reader.GetSchemaTable()
    if ($schema -eq $null) {
      continue
    }

    $columns = @()
    foreach ($schemaRow in $schema.Rows) {
      $columns += [string]$schemaRow.ColumnName
    }

    $rows = @()
    while ($reader.Read()) {
      $row = [ordered]@{}
      foreach ($column in $columns) {
        $value = $reader[$column]
        if ($value -is [System.DBNull]) {
          $row[$column] = $null
        }
        elseif ($value -is [System.DateTime]) {
          $row[$column] = $value.ToString("o")
        }
        else {
          $row[$column] = $value
        }
      }
      $rows += [pscustomobject]$row
    }

    $resultSets += [pscustomobject]@{
      columns = $columns
      rows = @($rows)
      rowCount = @($rows).Count
    }
  } while ($reader.NextResult())

  $firstRows = @()
  if (@($resultSets).Count -gt 0) {
    $firstRows = @($resultSets[0].rows)
  }

  [pscustomobject]@{
    rows = @($firstRows)
    rowCount = @($firstRows).Count
    resultSetCount = @($resultSets).Count
    resultSets = @($resultSets)
    recordsAffected = $reader.RecordsAffected
  } | ConvertTo-Json -Depth 8 -Compress
}
finally {
  $cn.Close()
}
`;
  const result = await runner.execPowerShell(script, 120000);
  return compactText(result.stdout || result.stderr);
}
