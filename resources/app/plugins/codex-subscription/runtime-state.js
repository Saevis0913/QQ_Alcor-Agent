// Alcor reimports index.js during a rescan. Keep pending work and the
// in-flight requests owned by this plugin across those entry reimports.
export const subscriptionState = {
  activeMode: undefined,
  lifetime: new AbortController(),
  work: undefined,
  listCache: undefined,
  chat: undefined
};
