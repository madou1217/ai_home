'use strict';

const { createIdeInstaller } = require('./ide-installer-factory');

module.exports = createIdeInstaller({
  id: 'vscode',
  name: 'Visual Studio Code',
  cask: 'visual-studio-code',
  wingetId: 'Microsoft.VisualStudioCode',
  windowsDisplayNames: [
    'Microsoft Visual Studio Code',
    'Microsoft Visual Studio Code (User)'
  ],
  linuxRepository: {
    packageName: 'code',
    apt: {
      keyUrl: 'https://packages.microsoft.com/keys/microsoft.asc',
      keyPath: '/usr/share/keyrings/microsoft.gpg',
      repositoryPath: '/etc/apt/sources.list.d/vscode.list',
      repository: 'deb [arch=amd64,arm64,armhf signed-by=/usr/share/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/code stable main'
    },
    rpm: {
      keyUrl: 'https://packages.microsoft.com/keys/microsoft.asc',
      repositoryPath: '/etc/yum.repos.d/vscode.repo',
      repository: '[code]\nname=Visual Studio Code\nbaseurl=https://packages.microsoft.com/yumrepos/vscode\nenabled=1\nautorefresh=1\ntype=rpm-md\ngpgcheck=1\ngpgkey=https://packages.microsoft.com/keys/microsoft.asc'
    }
  }
});
