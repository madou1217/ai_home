'use strict';

const PLATFORM_IDS = Object.freeze(['macos', 'windows', 'linux']);

const PARAMETER_DEFINITIONS = Object.freeze({
  version: Object.freeze({ key: 'version', label: '版本号', placeholder: '例如 22 或 3.12.7' }),
  package: Object.freeze({ key: 'package', label: '包名', placeholder: '例如 typescript' }),
  script: Object.freeze({ key: 'script', label: '脚本路径', placeholder: '例如 scripts/check.py' }),
  environment: Object.freeze({ key: 'environment', label: '环境名称', placeholder: '例如 analytics' }),
  environmentPath: Object.freeze({ key: 'environmentPath', label: '环境目录', placeholder: '例如 .venv' })
});

function parameters(...keys) {
  return keys.map((key) => PARAMETER_DEFINITIONS[key]).filter(Boolean);
}

module.exports = {
  PARAMETER_DEFINITIONS,
  PLATFORM_IDS,
  parameters
};
