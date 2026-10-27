/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';

// 无原生环境：tcp-socket 顶层 NativeEventEmitter 会崩，mock 之
jest.mock('react-native-tcp-socket', () => ({
  createConnection: jest.fn(),
  default: { createConnection: jest.fn() }
}));

jest.mock('react-native-webview', () => ({ WebView: () => null }));

jest.mock('@react-native-clipboard/clipboard', () => ({
  __esModule: true,
  default: { setString: jest.fn(), getString: jest.fn(async () => '') }
}));

test('renders correctly', async () => {
  await ReactTestRenderer.act(() => {
    ReactTestRenderer.create(<App />);
  });
});