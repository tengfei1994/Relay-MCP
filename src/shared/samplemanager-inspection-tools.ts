import { ensureRemoteSuccess, type RemoteExecutionOptions, type RemoteRunner } from "./remote-runner.js";
import { instancePaths, type SampleManagerInstanceRef } from "./samplemanager-tools.js";

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function validateRemoteLiteral(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || /[\r\n\0]/.test(trimmed)) throw new Error(`Invalid ${label}`);
  return trimmed;
}

function validateDatabaseTarget(value: string, label: string): string {
  const trimmed = validateRemoteLiteral(value, label);
  if (/[";]/.test(trimmed)) throw new Error(`Invalid ${label}`);
  return trimmed;
}

function validateSimpleName(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 256 || /[\r\n\0]/.test(trimmed)) throw new Error(`Invalid ${label}`);
  return trimmed;
}

export interface AssemblyTypeInspectionOptions {
  assemblyPath: string;
  typeName: string;
  memberFilter?: string;
  includeInherited?: boolean;
  includeNonPublic?: boolean;
  maxMembers?: number;
  execution?: RemoteExecutionOptions;
}

export async function inspectSampleManagerAssemblyType(
  runner: RemoteRunner,
  options: AssemblyTypeInspectionOptions,
): Promise<string> {
  const assemblyPath = validateRemoteLiteral(options.assemblyPath, "assemblyPath");
  const typeName = validateSimpleName(options.typeName, "typeName");
  const memberFilter = options.memberFilter ? validateSimpleName(options.memberFilter, "memberFilter") : undefined;
  const maxMembers = options.maxMembers ?? 100;
  if (!Number.isInteger(maxMembers) || maxMembers < 1 || maxMembers > 500) {
    throw new Error("maxMembers must be an integer between 1 and 500");
  }
  const script = `
$ErrorActionPreference = "Stop"
$assemblyPath = ${psQuote(assemblyPath)}
$typeName = ${psQuote(typeName)}
$memberFilter = ${memberFilter ? psQuote(memberFilter) : "$null"}
$maxMembers = ${maxMembers}
if (-not (Test-Path -LiteralPath $assemblyPath -PathType Leaf)) { throw "Assembly not found: $assemblyPath" }
$resolvedPath = (Resolve-Path -LiteralPath $assemblyPath).Path
$assemblyDirectory = Split-Path -Parent $resolvedPath
$dependencyErrors = New-Object 'System.Collections.Generic.List[string]'
$resolver = [ResolveEventHandler]{
  param($sender, $args)
  try {
    $simpleName = (New-Object Reflection.AssemblyName($args.Name)).Name
    $candidate = Join-Path $assemblyDirectory ($simpleName + '.dll')
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return [Reflection.Assembly]::ReflectionOnlyLoadFrom($candidate) }
  } catch { $null = $dependencyErrors.Add($_.Exception.Message) }
  return $null
}
[AppDomain]::CurrentDomain.add_ReflectionOnlyAssemblyResolve($resolver)
try {
  $assembly = [Reflection.Assembly]::ReflectionOnlyLoadFrom($resolvedPath)
  try { $types = @($assembly.GetTypes()) } catch [Reflection.ReflectionTypeLoadException] {
    $types = @($_.Exception.Types | Where-Object { $_ })
    $_.Exception.LoaderExceptions | ForEach-Object { if ($_) { $null = $dependencyErrors.Add($_.Message) } }
  }
  $selected = @($types | Where-Object { $_.FullName -ieq $typeName -or $_.Name -ieq $typeName })
  if ($selected.Count -eq 0) { throw "Type not found: $typeName" }
  if ($selected.Count -gt 1) { throw "Type name is ambiguous: $typeName" }
  $type = $selected[0]
  $flags = [Reflection.BindingFlags]::Instance -bor [Reflection.BindingFlags]::Static -bor [Reflection.BindingFlags]::Public
  if (${options.includeNonPublic ? "$true" : "$false"}) { $flags = $flags -bor [Reflection.BindingFlags]::NonPublic }
  if (-not ${options.includeInherited === false ? "$true" : "$false"}) { $flags = $flags -bor [Reflection.BindingFlags]::FlattenHierarchy }
  function Match-Member([string]$name) { return (-not $memberFilter) -or $name.IndexOf($memberFilter, [StringComparison]::OrdinalIgnoreCase) -ge 0 }
  $properties = @($type.GetProperties($flags) | Where-Object { Match-Member $_.Name } | Sort-Object Name | Select-Object -First $maxMembers | ForEach-Object {
    $accessor = $_.GetGetMethod($true); if (-not $accessor) { $accessor = $_.GetSetMethod($true) }
    [pscustomobject]@{ name=$_.Name; type=$_.PropertyType.FullName; canRead=$_.CanRead; canWrite=$_.CanWrite; declaredBy=$_.DeclaringType.FullName; isStatic=if($accessor){$accessor.IsStatic}else{$false} }
  })
  $methods = @($type.GetMethods($flags) | Where-Object { -not $_.IsSpecialName -and (Match-Member $_.Name) } | Sort-Object Name | Select-Object -First $maxMembers | ForEach-Object {
    [pscustomobject]@{ name=$_.Name; returnType=$_.ReturnType.FullName; isStatic=$_.IsStatic; declaredBy=$_.DeclaringType.FullName; parameters=@($_.GetParameters() | ForEach-Object { [pscustomobject]@{ name=$_.Name; type=$_.ParameterType.FullName; optional=$_.IsOptional } }) }
  })
  $events = @($type.GetEvents($flags) | Where-Object { Match-Member $_.Name } | Sort-Object Name | Select-Object -First $maxMembers | ForEach-Object {
    [pscustomobject]@{ name=$_.Name; handlerType=$_.EventHandlerType.FullName; declaredBy=$_.DeclaringType.FullName }
  })
  $baseTypes = @(); $base = $type.BaseType; while ($base) { $baseTypes += $base.FullName; $base = $base.BaseType }
  $total = $properties.Count + $methods.Count + $events.Count
  [pscustomobject]@{
    assembly=[pscustomobject]@{ path=$resolvedPath; sha256=(Get-FileHash -LiteralPath $resolvedPath -Algorithm SHA256).Hash.ToLowerInvariant(); assemblyName=$assembly.GetName().Name; assemblyVersion=[string]$assembly.GetName().Version; fileVersion=[Diagnostics.FileVersionInfo]::GetVersionInfo($resolvedPath).FileVersion }
    type=[pscustomobject]@{ name=$type.Name; fullName=$type.FullName; namespace=$type.Namespace; baseTypes=$baseTypes; isAbstract=$type.IsAbstract; isInterface=$type.IsInterface; isPublic=$type.IsPublic }
    properties=$properties; methods=$methods; events=$events
    dependencyErrors=@($dependencyErrors | Select-Object -Unique)
    truncated=($total -ge ($maxMembers * 3))
    limits=[pscustomobject]@{ maxMembers=$maxMembers; memberFilter=$memberFilter; includeInherited=${options.includeInherited !== false ? "$true" : "$false"}; includeNonPublic=${options.includeNonPublic ? "$true" : "$false"} }
  } | ConvertTo-Json -Depth 7 -Compress
} finally { [AppDomain]::CurrentDomain.remove_ReflectionOnlyAssemblyResolve($resolver) }
`;
  const result = await runner.execPowerShell(script, 60000, options.execution ?? {});
  ensureRemoteSuccess(result);
  return result.stdout || result.stderr;
}

export interface FormTaskContractOptions {
  instance: SampleManagerInstanceRef;
  databaseHost: string;
  databaseName: string;
  formName: string;
  taskName: string;
  assemblyPath?: string;
  typeName?: string;
  controlNames?: string[];
  maxMembers?: number;
  execution?: RemoteExecutionOptions;
}

type CheckStatus = "pass" | "warning" | "fail" | "unknown";

export async function validateSampleManagerFormTaskContract(
  runner: RemoteRunner,
  options: FormTaskContractOptions,
): Promise<string> {
  const formName = validateSimpleName(options.formName, "formName");
  const taskName = validateSimpleName(options.taskName, "taskName");
  const databaseHost = validateDatabaseTarget(options.databaseHost, "databaseHost");
  const databaseName = validateDatabaseTarget(options.databaseName, "databaseName");
  const controls = [...new Set((options.controlNames ?? []).map((name) => validateSimpleName(name, "controlName")))];
  const paths = instancePaths(options.instance);
  const findings: Array<{ severity: "error" | "warning" | "info"; code: string; message: string; evidence?: unknown }> = [];
  const unknowns: string[] = [];
  const checks: Record<string, { status: CheckStatus; evidence?: unknown; error?: string }> = {};

  const filesystemScript = `
# relay-form-contract:filesystem
$ErrorActionPreference = "Stop"
$formsRoot = ${psQuote(paths.forms)}
$formsBin = ${psQuote(paths.formsBin)}
$formName = ${psQuote(formName)}
$requestedControls = @(${controls.map(psQuote).join(",")})
$candidateNames = @($formName + '.xml', $formName + '.frm')
$formFiles = @()
if (Test-Path -LiteralPath $formsRoot -PathType Container) {
  $candidates = @(Get-ChildItem -LiteralPath $formsRoot -File -Recurse -ErrorAction Stop | Where-Object { $candidateNames -contains $_.Name } | Select-Object -First 20)
  foreach ($file in $candidates) {
    $identity = $null; $controls = @(); $parseError = $null
    try {
      [xml]$xml = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction Stop
      $root = $xml.DocumentElement
      foreach ($attributeName in @('Name','name','FormName','formName','Identity','identity')) { if (-not $identity -and $root.HasAttribute($attributeName)) { $identity = $root.GetAttribute($attributeName) } }
      $nodes = @($xml.SelectNodes('//*'))
      foreach ($node in $nodes) {
        $controlName = $null
        foreach ($attributeName in @('Name','name','ControlName','controlName','ID','id')) { if (-not $controlName -and $node.Attributes[$attributeName]) { $controlName = $node.Attributes[$attributeName].Value } }
        if ($controlName -and (($requestedControls.Count -eq 0) -or ($requestedControls -contains $controlName))) {
          $controls += [pscustomobject]@{ name=$controlName; type=$node.LocalName; element=$node.Name }
        }
      }
    } catch { $parseError = $_.Exception.Message }
    $formFiles += [pscustomobject]@{ path=$file.FullName; identity=$identity; controls=@($controls); parseError=$parseError; sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
  }
}
$cacheFiles = @()
if (Test-Path -LiteralPath $formsBin -PathType Container) {
  $cacheFiles = @(Get-ChildItem -LiteralPath $formsBin -File -Recurse -ErrorAction Stop | Where-Object { $_.Name -ieq ($formName + '.binform') } | Select-Object -First 50 | ForEach-Object { $_.FullName })
}
[pscustomobject]@{ formsRoot=$formsRoot; formsBin=$formsBin; formFiles=$formFiles; cacheFiles=$cacheFiles; bounded=$true } | ConvertTo-Json -Depth 7 -Compress
`;
  try {
    const result = await runner.execPowerShell(filesystemScript, 60000, options.execution ?? {});
    ensureRemoteSuccess(result);
    const evidence = JSON.parse(result.stdout || result.stderr);
    const formFiles = Array.isArray(evidence.formFiles) ? evidence.formFiles : [];
    const foundControls = new Set(formFiles.flatMap((file: any) => Array.isArray(file.controls) ? file.controls.map((control: any) => String(control.name).toLowerCase()) : []));
    checks.formDefinition = { status: formFiles.length > 0 ? "pass" : "fail", evidence };
    if (formFiles.length === 0) findings.push({ severity: "error", code: "form_definition_missing", message: `No ${formName}.xml/.frm definition was found under the configured Forms path.` });
    for (const control of controls) if (!foundControls.has(control.toLowerCase())) findings.push({ severity: "error", code: "form_control_missing", message: `Control '${control}' was not found in the target form definition.` });
    if (Array.isArray(evidence.cacheFiles) && evidence.cacheFiles.length > 0) findings.push({ severity: "info", code: "compiled_form_cache_present", message: "Compiled form cache exists and must be cleared only when the form definition changes.", evidence: evidence.cacheFiles });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.formDefinition = { status: "unknown", error: message };
    unknowns.push(`Form definition inspection failed: ${message}`);
  }

  const databaseScript = `
# relay-form-contract:database
$ErrorActionPreference = "Stop"
$connection = New-Object Data.SqlClient.SqlConnection ${psQuote(`Server=${databaseHost};Database=${databaseName};Integrated Security=True;TrustServerCertificate=True`)}
$targets = @('MASTER_MENU','TASK','FORM')
$searchValues = @(${psQuote(formName)},${psQuote(taskName)})
$matches = @(); $bindingRows = @(); $missingTables = @()
try {
  $connection.Open()
  foreach ($tableName in $targets) {
    $columnCommand = $connection.CreateCommand()
    $columnCommand.CommandText = "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='dbo' AND TABLE_NAME=@table AND DATA_TYPE IN ('char','nchar','varchar','nvarchar') ORDER BY ORDINAL_POSITION"
    $null = $columnCommand.Parameters.Add('@table',[Data.SqlDbType]::NVarChar,128); $columnCommand.Parameters['@table'].Value=$tableName
    $reader = $columnCommand.ExecuteReader(); $columns=@(); while($reader.Read()){ $columns += [string]$reader[0] }; $reader.Close()
    if ($columns.Count -eq 0) { $missingTables += $tableName; continue }
    foreach ($column in $columns) {
      foreach ($searchValue in $searchValues) {
        $command = $connection.CreateCommand()
        $escapedColumn = '[' + $column.Replace(']',']]') + ']'
        $command.CommandText = "SELECT TOP (20) $escapedColumn AS matched_value FROM [dbo].[$tableName] WHERE RTRIM($escapedColumn)=@value"
        $null = $command.Parameters.Add('@value',[Data.SqlDbType]::NVarChar,256); $command.Parameters['@value'].Value=$searchValue
        $rowReader=$command.ExecuteReader(); while($rowReader.Read()){ $matches += [pscustomobject]@{ table=$tableName; column=$column; value=[string]$rowReader[0]; searched=$searchValue } }; $rowReader.Close()
      }
    }
    if ($tableName -eq 'MASTER_MENU') {
      $predicates = @(); $parameterIndex = 0
      foreach ($column in $columns) {
        foreach ($searchValue in $searchValues) {
          $escapedColumn = '[' + $column.Replace(']',']]') + ']'
          $parameterName = '@binding' + $parameterIndex
          $predicates += "RTRIM($escapedColumn)=$parameterName"
          $parameterIndex++
        }
      }
      if ($predicates.Count -gt 0) {
        $bindingCommand = $connection.CreateCommand()
        $bindingCommand.CommandText = "SELECT TOP (20) * FROM [dbo].[MASTER_MENU] WHERE " + ($predicates -join ' OR ')
        $parameterIndex = 0
        foreach ($column in $columns) { foreach ($searchValue in $searchValues) {
          $parameterName = '@binding' + $parameterIndex
          $null = $bindingCommand.Parameters.Add($parameterName,[Data.SqlDbType]::NVarChar,256); $bindingCommand.Parameters[$parameterName].Value=$searchValue
          $parameterIndex++
        } }
        $bindingReader=$bindingCommand.ExecuteReader()
        while($bindingReader.Read()){
          $row = [ordered]@{}; $values=@()
          for($i=0;$i -lt $bindingReader.FieldCount;$i++){
            $value = if($bindingReader.IsDBNull($i)){$null}else{[string]$bindingReader.GetValue($i)}
            $row[$bindingReader.GetName($i)]=$value; if($value){$values += $value.Trim()}
          }
          $bindingRows += [pscustomobject]@{ row=$row; containsForm=($values -contains ${psQuote(formName)}); containsTask=($values -contains ${psQuote(taskName)}) }
        }
        $bindingReader.Close()
      }
    }
  }
  [pscustomobject]@{ databaseHost=${psQuote(databaseHost)}; databaseName=${psQuote(databaseName)}; matches=$matches; masterMenuBindingRows=$bindingRows; missingTables=$missingTables; readOnly=$true } | ConvertTo-Json -Depth 8 -Compress
} finally { if ($connection.State -ne [Data.ConnectionState]::Closed) { $connection.Close() }; $connection.Dispose() }
`;
  try {
    const result = await runner.execPowerShell(databaseScript, 90000, options.execution ?? {});
    ensureRemoteSuccess(result);
    const evidence = JSON.parse(result.stdout || result.stderr);
    const matches = Array.isArray(evidence.matches) ? evidence.matches : [];
    const formMatched = matches.some((item: any) => String(item.searched).toLowerCase() === formName.toLowerCase());
    const taskMatched = matches.some((item: any) => String(item.searched).toLowerCase() === taskName.toLowerCase());
    const bindingRows = Array.isArray(evidence.masterMenuBindingRows) ? evidence.masterMenuBindingRows : [];
    const bindingMatched = bindingRows.some((item: any) => item.containsForm === true && item.containsTask === true);
    checks.databaseBinding = { status: formMatched && taskMatched && bindingMatched ? "pass" : "fail", evidence };
    if (!formMatched) findings.push({ severity: "error", code: "form_database_binding_missing", message: `No FORM/TASK/MASTER_MENU text column matched form '${formName}'.` });
    if (!taskMatched) findings.push({ severity: "error", code: "task_database_binding_missing", message: `No FORM/TASK/MASTER_MENU text column matched task '${taskName}'.` });
    if (formMatched && taskMatched && !bindingMatched) findings.push({ severity: "error", code: "master_menu_form_task_binding_missing", message: `Form '${formName}' and task '${taskName}' were found, but not together on one MASTER_MENU row.` });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.databaseBinding = { status: "unknown", error: message };
    unknowns.push(`Database binding inspection failed: ${message}`);
  }

  if (options.assemblyPath) {
    try {
      const evidence = JSON.parse(await inspectSampleManagerAssemblyType(runner, { assemblyPath: options.assemblyPath, typeName: options.typeName ?? taskName, includeInherited: true, maxMembers: options.maxMembers ?? 100, execution: options.execution }));
      checks.assemblyContract = { status: evidence.type?.fullName ? "pass" : "fail", evidence };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checks.assemblyContract = { status: "unknown", error: message };
      unknowns.push(`Assembly contract inspection failed: ${message}`);
    }
  } else {
    checks.assemblyContract = { status: "unknown", error: "assemblyPath was not supplied" };
    unknowns.push("Assembly contract was not checked because assemblyPath was not supplied.");
  }

  const statuses = Object.values(checks).map((check) => check.status);
  const overallStatus: CheckStatus = statuses.includes("fail") ? "fail" : statuses.includes("unknown") ? "unknown" : findings.some((finding) => finding.severity === "warning") ? "warning" : "pass";
  return JSON.stringify({
    capability: "form_task.contract", readOnly: true, mutationAttempted: false, overallStatus,
    target: { formName, taskName, assemblyPath: options.assemblyPath ?? null, typeName: options.typeName ?? taskName, databaseHost, databaseName },
    checks, findings, unknowns,
  });
}
