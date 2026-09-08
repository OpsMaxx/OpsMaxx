# winget manifests

What was submitted to [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs)
for `OpsMaxx.OpsMaxx`, kept here so the next version is a diff rather than a rewrite.

- `InstallerType: nullsoft` — winget's name for the NSIS installer electron-builder
  produces. It is not `nsis`; the schema rejects that.
- `Scope: user` — `nsis.perMachine` is `false` in `electron-builder.yml`.
- `ReleaseDate` is quoted, or a YAML parser hands the schema a date object where it
  wants a string.
- `InstallerSha256` must match the published file. Take it from the release notes'
  checksum table and verify it against the download before submitting.

Validate before opening a PR. On Windows:

```powershell
winget validate --manifest manifests/o/OpsMaxx/OpsMaxx/<version>
```

Anywhere else, against the published schemas:

```bash
pip install jsonschema pyyaml
# manifest.version / manifest.installer / manifest.defaultLocale, v1.6.0
# https://raw.githubusercontent.com/microsoft/winget-cli/master/schemas/JSON/manifests/v1.6.0/
```
