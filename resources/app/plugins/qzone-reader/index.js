import { readLocalQzoneSnapshot } from '../../src/qzone.js';

export const providers = {
  'qzone.snapshot': async () => {
    const { state, day, items } = await readLocalQzoneSnapshot();
    return { state, day, items, source: 'local_qzone_snapshot', contentIsUserGenerated: true };
  }
};
