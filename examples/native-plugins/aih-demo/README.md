# AIH portable native plugin demo

One canonical package projects into AIH, Claude skills-dir, Codex local marketplace, OpenCode local plugin config, and Pi extension shape. Native runtime success is reported only when that host is installed and exercised.

Install with `aih native plugin install examples/native-plugins/aih-demo --provider codex`
or `--provider claude`, then start a fresh native session. The bundled skill is
namespaced: invoke `$aih-demo:aih-demo` in Codex or `/aih-demo:aih-demo` in Claude.
The Codex compatibility manifest explicitly declares `skills: "./skills/"`.

Reproduce native loading without remote inference or user accounts:

```sh
node scripts/native-plugin-use-demo.js codex
node scripts/native-plugin-use-demo.js claude
```

Each probe installs this package through the native plugin manager, invokes the
bundled skill through the actual native client, then repeats after disable,
re-enable, and removal. Its local fixture returns `AIH_PLUGIN_DEMO_OK` only when
the native request contains the installed plugin's skill body. This is native
plugin instruction loading evidence, separate from JavaScript tool execution.
