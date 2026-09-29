param(
    [ValidateSet('doctor', 'build', 'start', 'stop', 'logs')]
    [string]$Action = 'doctor'
)

$ErrorActionPreference = 'Stop'
$projectPath = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$imageName = 'solanafoundation/anchor@sha256:facc4ebd0738ba7ebc1eb4ef000deab6b37e7747960d3f400c73c40c5421b5de'
$validatorName = 'onephone-local-validator'

function Invoke-Docker {
    param([string[]]$DockerArgs)
    & docker @DockerArgs
    if ($LASTEXITCODE -ne 0) { throw "Docker exited with code $LASTEXITCODE" }
}

$mount = "type=bind,source=$projectPath,target=/workspace"
switch ($Action) {
    'doctor' {
        Invoke-Docker -DockerArgs @('run', '--rm', $imageName, 'bash', '-c',
            'set -e; rustc --version; cargo --version; anchor --version; solana --version; node --version')
    }
    'build' {
        Invoke-Docker -DockerArgs @('run', '--rm', '--mount', $mount, '--workdir', '/workspace',
            '--mount', 'type=volume,source=onephone-cargo-registry,target=/root/.cargo/registry',
            '--mount', 'type=volume,source=onephone-sbf-cache,target=/root/.cache/solana',
            $imageName, 'cargo', 'build-sbf', '--manifest-path', 'programs/onephone/Cargo.toml',
            '--sbf-out-dir', 'target/deploy', '--tools-version', 'v1.56', '--arch', 'v0', '--', '--locked')
    }
    'start' {
        $programId = (Get-Content -LiteralPath (Join-Path $projectPath 'program-id.txt') -Raw).Trim()
        if ($programId -notmatch '^[1-9A-HJ-NP-Za-km-z]{32,44}$') { throw 'Invalid program-id.txt' }
        if (!(Test-Path -LiteralPath (Join-Path $projectPath 'target/deploy/onephone.so'))) {
            throw 'Build the program first: ./scripts/solana.ps1 build'
        }
        $fixturePath = Join-Path $projectPath '.local/validator-accounts'
        if (!(Test-Path -LiteralPath $fixturePath)) { throw 'Generate the local test fixtures first.' }
        $validatorArgs = @('run', '--detach', '--rm', '--name', $validatorName,
            '--mount', $mount, '--workdir', '/workspace',
            '--publish', '127.0.0.1:18999:8899', '--publish', '127.0.0.1:19000:8900',
            $imageName, 'solana-test-validator', '--ledger', '/tmp/onephone-ledger',
            '--bind-address', '0.0.0.0', '--rpc-port', '8899',
            '--bpf-program', $programId, '/workspace/target/deploy/onephone.so',
            '--account-dir', '/workspace/.local/validator-accounts', '--quiet')
        Invoke-Docker -DockerArgs $validatorArgs
    }
    'stop' { Invoke-Docker -DockerArgs @('stop', $validatorName) }
    'logs' { Invoke-Docker -DockerArgs @('logs', '--tail', '80', $validatorName) }
}
