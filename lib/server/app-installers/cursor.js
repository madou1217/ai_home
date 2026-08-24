'use strict';

const { createIdeInstaller } = require('./ide-installer-factory');

module.exports = createIdeInstaller({
  id: 'cursor',
  name: 'Cursor',
  cask: 'cursor',
  wingetId: 'Anysphere.Cursor',
  windowsDisplayNames: ['Cursor'],
  linuxRepository: {
    packageName: 'cursor',
    apt: {
      keyUrl: 'https://downloads.cursor.com/keys/anysphere.asc',
      keyPath: '/etc/apt/keyrings/cursor.gpg',
      repositoryPath: '/etc/apt/sources.list.d/cursor.list',
      repository: 'deb [arch=amd64,arm64 signed-by=/etc/apt/keyrings/cursor.gpg] https://downloads.cursor.com/aptrepo stable main'
    },
    rpm: {
      keyUrl: 'https://downloads.cursor.com/keys/anysphere.asc',
      repositoryPath: '/etc/yum.repos.d/cursor.repo',
      repository: '[cursor]\nname=Cursor\nbaseurl=https://downloads.cursor.com/yumrepo\nenabled=1\ngpgcheck=1\ngpgkey=https://downloads.cursor.com/keys/anysphere.asc'
    }
  }
});
