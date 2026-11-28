$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$sys = Join-Path $root 'aih-netguard.sys'
if (-not (Test-Path $sys)) { throw "missing $sys; run build.ps1 first" }

$subject = 'CN=AIH NetGuard Test'
$cert = Get-ChildItem Cert:\LocalMachine\My |
  Where-Object { $_.Subject -eq $subject -and $_.HasPrivateKey } |
  Select-Object -First 1
if (-not $cert) {
  $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $subject `
    -CertStoreLocation Cert:\LocalMachine\My -KeyUsage DigitalSignature `
    -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -NotAfter (Get-Date).AddYears(3)
}
Write-Host ('certificate: ' + $cert.Thumbprint + ' ' + $cert.Subject)

$cerPath = Join-Path $root 'aih-netguard-test.cer'
Export-Certificate -Cert $cert -FilePath $cerPath -Force | Out-Null
foreach ($store in @('Root', 'TrustedPublisher')) {
  $path = 'Cert:\LocalMachine\' + $store
  $present = Get-ChildItem $path | Where-Object { $_.Thumbprint -eq $cert.Thumbprint }
  if (-not $present) { Import-Certificate -FilePath $cerPath -CertStoreLocation $path | Out-Null }
}

$result = Set-AuthenticodeSignature -FilePath $sys -Certificate $cert -HashAlgorithm SHA256
if ($result.Status -ne 'Valid') {
  throw ('signing failed: ' + $result.Status + ' ' + $result.StatusMessage)
}
$verify = Get-AuthenticodeSignature $sys
if ($verify.Status -ne 'Valid') {
  throw ('signature verification failed: ' + $verify.Status)
}
Get-Item $sys | Select-Object FullName, Length, LastWriteTime | Format-List