$pkg = Get-Content "package.json" -Raw | ConvertFrom-Json
$declared = @($pkg.contributes.commands.command | Sort-Object)
$registered = @((Select-String -Path "src\extension.ts" -Pattern "registerCommand\('([^']+)'" -AllMatches).Matches | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
$diff = Compare-Object -ReferenceObject $declared -DifferenceObject $registered
Write-Host "Declared commands: $($declared.Count)"
Write-Host "Registered in code: $($registered.Count)"
Write-Host "--- Declared but missing register ---"
$diff | Where-Object SideIndicator -eq '<=' | ForEach-Object { Write-Host "  $($_.InputObject)" }
Write-Host "--- Registered but missing declare ---"
$diff | Where-Object SideIndicator -eq '=>' | ForEach-Object { Write-Host "  $($_.InputObject)" }
Write-Host ""
Write-Host "--- Config keys declared in package.json ---"
$cfg = $pkg.contributes.configuration.properties
$cfg.PSObject.Properties.Name | Sort-Object | ForEach-Object { Write-Host "  $_" }
Write-Host ""
Write-Host "--- Config keys read in src/types.ts ---"
$readKeys = @((Select-String -Path "src\types.ts" -Pattern "get<[^>]+>\('([^']+)'" -AllMatches).Matches | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
$readKeys | ForEach-Object { Write-Host "  ghcpMem.$_" }
