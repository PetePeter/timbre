import { PhapClient, type PhapClientOptions } from '../../src/phone/phap-client.js';
import { PhoneBridge, type PhoneBridgeDeps } from '../../src/phone/phone-bridge.js';
import { FakePhapServer } from './fake-phap-server.js';

export interface PhoneBridgeFixtureOptions {
  token?: string;
  clientOptions: Omit<PhapClientOptions, 'uri' | 'token'>;
  bridge: Omit<PhoneBridgeDeps, 'client'>;
  configureServer?: (server: FakePhapServer) => void | Promise<void>;
}

export interface PhoneBridgeFixture {
  server: FakePhapServer;
  client: PhapClient;
  bridge: PhoneBridge;
  close(): Promise<void>;
}

export async function createPhoneBridgeFixture(options: PhoneBridgeFixtureOptions): Promise<PhoneBridgeFixture> {
  const token = options.token ?? 'tok';
  const server = new FakePhapServer(token);
  await server.listen();

  try {
    await options.configureServer?.(server);
    const client = new PhapClient({ uri: server.uri, token, ...options.clientOptions });
    const bridge = new PhoneBridge({ client, ...options.bridge });
    try {
      bridge.start();
      client.start();
      await waitForConnection(client);
    } catch (error) {
      bridge.stop();
      client.stop();
      throw error;
    }

    let closed = false;
    return {
      server,
      client,
      bridge,
      async close() {
        if (closed) return;
        closed = true;
        bridge.stop();
        client.stop();
        await server.close();
      },
    };
  } catch (error) {
    await server.close();
    throw error;
  }
}

async function waitForConnection(client: PhapClient, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!client.isConnected()) {
    if (Date.now() >= deadline) throw new Error('PhAP client did not connect to the fake server');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
