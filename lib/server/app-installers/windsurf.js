'use strict';

const { createIdeInstaller } = require('./ide-installer-factory');

const STABLE_ORIGIN = 'https://windsurf-stable.codeiumdata.com/wVxQEIWkwPUEAGf3';

module.exports = createIdeInstaller({
  id: 'windsurf',
  name: 'Devin Desktop',
  cask: 'devin-desktop',
  wingetId: 'Codeium.Windsurf',
  windowsDisplayNames: ['Devin', 'Windsurf'],
  linuxRepository: {
    packageName: 'devin-desktop',
    apt: {
      keyUrl: `${STABLE_ORIGIN}/windsurf.gpg`,
      keyPath: '/etc/apt/keyrings/windsurf-stable.gpg',
      repositoryPath: '/etc/apt/sources.list.d/windsurf.list',
      repository: `deb [arch=amd64 signed-by=/etc/apt/keyrings/windsurf-stable.gpg] ${STABLE_ORIGIN}/apt stable main`
    },
    rpm: {
      keyUrl: `${STABLE_ORIGIN}/yum/RPM-GPG-KEY-windsurf`,
      repositoryPath: '/etc/yum.repos.d/windsurf.repo',
      repository: `[windsurf]\nname=Devin Desktop\nbaseurl=${STABLE_ORIGIN}/yum/repo/\nenabled=1\ngpgcheck=1\nmetadata_expire=1h\ngpgkey=${STABLE_ORIGIN}/yum/RPM-GPG-KEY-windsurf`
    }
  }
});
