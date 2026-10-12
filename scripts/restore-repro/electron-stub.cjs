// electron 桩：让主进程模块能在纯 Node 下运行（复现用）
let userData = '/tmp/linkto-repro/userData'
module.exports = {
  __setUserData(p) {
    userData = p
  },
  __getUserData: () => userData,
  app: {
    getPath: name => (name === 'userData' ? userData : `/tmp/linkto-repro/${name}`)
  },
  safeStorage: {
    isEncryptionAvailable: () => false
  },
  dialog: {
    showOpenDialog: async () => ({
      canceled: false,
      filePaths: [process.env.REPRO_BACKUP_DIR || '/tmp/linkto-repro/backups']
    })
  },
  BrowserWindow: { getAllWindows: () => [{}] }
}