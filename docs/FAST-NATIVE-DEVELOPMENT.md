# Fast native development path

The authoritative runtime for this prototype is Node 22.23.2, pnpm 10.34.3,
Next 16.3.0, and webpack. `.mise.toml`, `package.json`, the Next scripts, and the
native runner now name those versions and that bundler explicitly.

The canonical `main-prototype` build is WSL2/Linux. A fresh process audit found
the source of the earlier runtime mix-up: a separate legacy sibling preview on
port 3100 was launched through the Codex primary runtime with Windows
`node.exe`. It is not the port-3102 v0.1 candidate and was left untouched. The
workspace is stored under `/mnt/c`, so its files are reached through WSL's
Windows-backed `drvfs`/9p mount, but that storage location does not make the
canonical runtime Windows.

The verified runtime drift is narrower: the interactive WSL shell resolves a
Linuxbrew Node 26 binary while the project pins Linux Node 22.23.2. The running
preview uses the pinned Linux ELF binary, an ext4 `/tmp` source mirror, and an
ext4 dependency tree. The mirror avoids the higher metadata cost of traversing
dependencies on `/mnt/c`; it does not cross from Windows tooling into WSL.
Webpack remains explicit because the recorded Next/Turbopack path failed under
the available Linux runtime.

For checks and preview builds, mirror source to ext4 and reuse one ext4
dependency tree:

```bash
export ONSALE_NODE22_BIN=/path/to/node-v22.23.2/bin/node
export ONSALE_NATIVE_NODE_MODULES=/path/on/ext4/to/node_modules
bash scripts/native-node22.sh typecheck
bash scripts/native-node22.sh test tests/domain/onsale-public-contract.test.ts
bash scripts/native-node22.sh build
bash scripts/native-node22.sh dev -p 3102
```

The runner refuses Node drift, `/mnt/c` execution roots, and `/mnt/c`
dependencies before any build starts. It invokes package CLIs directly, so pnpm
never tries to relink the Windows-mounted dependency tree. `--webpack` remains
explicit until the known Next 16 parity/prerender Turbopack failures are retired
by a separate upgrade.
