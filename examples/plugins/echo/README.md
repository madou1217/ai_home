# AIH Echo Plugin Demo

This is the smallest runnable AIH plugin. It registers three contributions:

- `sample.echo.call` returns the supplied JSON value and the current plugin generation;
- `sample.echo.wait` waits for cancellation, proving generation drain reaches the plugin;
- `sample.echo.stats` reports cancellation observations.

The demo uses an isolated AIH home when run by the closure harness. For a real server, the management key must be configured and the server must already be running.

## Run it through the AIH control plane

```bash
aih plugin validate examples/plugins/echo --load
aih plugin pack examples/plugins/echo /tmp/aih-sample-echo.aih-plugin
aih plugin install /tmp/aih-sample-echo.aih-plugin
aih plugin enable aih.sample.echo
aih plugin call sample.echo.call --value-json '{"marker":"AIH_PLUGIN_DEMO_OK"}' --json
aih plugin list --json
aih plugin disable aih.sample.echo --remove
aih plugin doctor --json
aih plugin uninstall aih.sample.echo
```

Expected use output contains:

```json
{
  "value": {
    "echoed": { "marker": "AIH_PLUGIN_DEMO_OK" },
    "instanceId": "aih.sample.echo",
    "generation": 1
  }
}
```

The repository-level closure command runs the same lifecycle in a temporary home and also restarts the runtime before the second call:

```bash
node scripts/plugin-closure-demo.js --json
```

The command must show `pack`, `install`, `enable`, `use`, `restart`, `use-after-restart`, `disable`, `uninstall`, and `doctor` stages. It does not use the real `~/.ai_home`.
