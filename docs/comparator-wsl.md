# Comparator on Windows: use Docker or WSL/Linux

**Docker is now the recommended path** because it also avoids the corpus’s NTFS-invalid AINTLIB path. See `docker/README.md` and `docker/comparator.Dockerfile`. The WSL instructions below remain an alternative.

Native Windows is not a supported Comparator environment. `landrun` depends on Linux Landlock, and the pinned `math/lean` dependency set can contain paths that NTFS cannot represent. Do not treat a missing/failed `math_comparator` call as successful verification.

## Supported route

Use WSL2 Ubuntu (or another Linux environment) with a kernel that supports Landlock.

### 1. Check WSL

```powershell
wsl --status
wsl -l -v
```

If needed:

```powershell
wsl --install -d Ubuntu
wsl --update
```

### 2. Install Go and landrun

Landrun requires Go 1.24 or newer. Install Go from <https://go.dev/dl/> if your distribution's package is older, then:

```bash
git clone https://github.com/ZouUup/landrun.git
cd landrun
go build -o landrun cmd/landrun/main.go
sudo install -m 0755 landrun /usr/local/bin/landrun
landrun --version
```

### 3. Build Comparator and lean4export

The standalone Comparator repository is archived/deprecated. Comparator is integrated into Lean 4.35, while this corpus pins Lean 4.34.1. Version compatibility is the main risk; do not upgrade the project pin silently.

```bash
git clone https://github.com/leanprover/comparator.git
git clone https://github.com/leanprover/lean4export.git
cd comparator
lake build lean4export comparator
export PATH="$PWD/.lake/build/bin:$PWD/.lake/packages/lean4export/.lake/build/bin:$PATH"
```

Install Lean/elan inside WSL first if `lake` is missing.

### 4. Run a challenge

For a full build, prefer a Linux filesystem copy rather than `/mnt/c`:

```bash
cp -a /mnt/c/_Work/opencode-math-copilot/math/lean ~/math-lean
cd ~/math-lean
lake exe cache get
lake env comparator ComparatorChallenges/QuasiRiemannHypothesis.json
```

If the project is already built in place and compatible:

```bash
cd /mnt/c/_Work/opencode-math-copilot/math/lean
lake env comparator ComparatorChallenges/QuasiRiemannHypothesis.json
```

The Comparator README also recommends a `systemd-run` wrapper restricting `AF_UNIX` for the Landrun socket. Use it when available.

## What the plugin reports

`math_comparator` runs:

```text
lake env comparator ComparatorChallenges/<name>.json
```

If `comparator`, `landrun`, or `lean4export` is absent, the tool returns an explicit prerequisite error. That is the correct outcome on native Windows; it is not a verification pass.
