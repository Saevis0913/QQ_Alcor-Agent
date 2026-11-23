import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import manifest from '../package.json' with { type: 'json' };
import { loadConfig } from './config.mjs';
import { Backend } from './backend.mjs';
import { NativeBackend } from './native-backend.mjs';
import { createBridge } from './server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const { values } = parseArgs({ options: { config: { type: 'string', default: path.join(root, 'data/native.config.json') }, check: { type: 'boolean', default: false } } });
  const config = loadConfig(path.resolve(values.config));
  if(values.check&&config.backend.type==='native'){
    const host=config.listen.host.includes(':')?'[::1]':config.listen.host;
    const response=await fetch(`http://${host}:${config.listen.port}/health`,{redirect:'error',headers:{authorization:`Bearer ${config.listen.token}`},signal:AbortSignal.timeout(4000)});
    if(!response.ok)throw new Error('NATIVE_CORE_UNAVAILABLE');
    const result = await response.json();
    if (result?.name !== 'Alcor' || result.listening !== true || result.backend?.type !== 'native') {
      throw Object.assign(new Error(), { code: 'CORE_IDENTITY_MISMATCH' });
    }
    const ready = result.ready === true && result.backend.receiveReady === true && result.backend.qqOnline === true;
    console.log(JSON.stringify({ name: result.name, version: result.version, listening: result.listening,
      ready, backend: result.backend, messagesSent: 0 }, null, 2));
    if (!ready) process.exitCode = 2;
  } else if (values.check) {
    const backend = config.backend.type==='native'?new NativeBackend(config):new Backend(config);
    backend.start(() => {});
    try {
      const version = await backend.call('get_version_info', {});
      const status = await backend.call('get_status', {});
      const deadline = Date.now() + 3000;
      while (!['open', 'auth_failed'].includes(backend.snapshot().ws) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      const result = { checkedAt: new Date().toISOString(), backendName: version.data?.app_name ?? null, backendVersion: version.data?.app_version ?? null, protocol: version.data?.protocol_version ?? null, online: status.status === 'ok' && status.retcode === 0 && status.data?.online === true, transport: backend.snapshot(), messagesSent: 0 };
      console.log(JSON.stringify(result, null, 2));
      if (!result.online || result.transport.ws !== 'open') process.exitCode = 2;
    } finally { await backend.close(); }
  } else {
    const bridge = createBridge(config,{management:{configFile:path.resolve(values.config),stateFile:path.join(path.dirname(path.resolve(values.config)),'console-settings.json')}});
    const endpoints = await bridge.listen();
    console.log(JSON.stringify({ name: 'Alcor', version: manifest.version, ...endpoints, readOnly: config.readOnly, backendType:config.backend.type??'onebot' }));
    let closing = false;
    const stop = async () => { if (closing) return; closing = true; await bridge.close(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    if(process.connected){process.on('message',m=>{if(m?.type==='alcor-stop')stop().finally(()=>{if(process.connected)process.disconnect();});});process.once('disconnect',stop);}
  }
} catch (error) {
  const safe = /^[A-Z][A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'STARTUP_OR_CONFIG_ERROR';
  console.error(JSON.stringify({ error: safe, note: 'Check the local configuration, required files and available ports. Credential values are not logged.' }));
  process.exitCode = 1;
}
