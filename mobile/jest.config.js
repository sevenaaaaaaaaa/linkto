module.exports = {
  preset: '@react-native/jest-preset',
  transformIgnorePatterns: [
    'node_modules/(?!(react-native|@react-native|@react-native-async-storage|react-native-keychain|react-native-tcp-socket|react-native-webview|@react-native-clipboard|@noble)/)'
  ],
  // live 用例会真的访问中继；默认跳过，用 npm run test:live 手动跑
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/__tests__/.*\\.live\\.test\\.ts$']
};