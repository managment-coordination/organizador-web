param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference='Stop'
$folder=(Resolve-Path -LiteralPath $Directory).Path
if ((Split-Path $folder -Leaf) -notlike 'organizador-report-qa-*') { throw 'Only isolated QA reports are accepted.' }
$word=$null
try {
    $word=New-Object -ComObject Word.Application
    $word.Visible=$false
    $word.DisplayAlerts=0
    foreach ($file in Get-ChildItem -LiteralPath $folder -Filter '*.docx') {
        $document=$null
        try {
            $document=$word.Documents.Open($file.FullName,$false,$true,$false)
            $pdf=[System.IO.Path]::ChangeExtension($file.FullName,'.pdf')
            $document.ExportAsFixedFormat($pdf,17)
            & pdftoppm -scale-to 1250 -png $pdf (Join-Path $folder $file.BaseName)
            if ($LASTEXITCODE -ne 0) { throw 'PDF rendering failed.' }
            Write-Output $file.Name
        } finally { if ($document) { $document.Close(0) } }
    }
} finally {
    if ($word) { $word.Quit(); [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) }
}
