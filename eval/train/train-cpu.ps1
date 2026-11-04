# Runs lora_sft.py on the CPU at below-normal priority on 75% of the cores, so the PC stays usable.
# Usage: pwsh eval/train/train-cpu.ps1 --data <sft.jsonl> --out <dir> [more lora_sft.py args]
$cores = [Environment]::ProcessorCount
$mask = [int64]([math]::Pow(2, [math]::Floor($cores * 0.75)) - 1)
$script = Join-Path $PSScriptRoot 'lora_sft.py'
$p = Start-Process python -ArgumentList (@($script, '--cpu') + $args) -NoNewWindow -PassThru
$p.PriorityClass = 'BelowNormal'
$p.ProcessorAffinity = [IntPtr]$mask
$p.WaitForExit()
exit $p.ExitCode
