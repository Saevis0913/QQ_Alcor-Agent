export function createQzoneRoutes(service) {
  if (!service) return [];
  return [
    { method: 'GET', pattern: '/api/qzone/status', handler: ({ res, json }) => service.status().then((value) => json(res, 200, value)) },
    { method: 'GET', pattern: '/api/qzone/snapshot', handler: ({ res, json }) => service.snapshot().then((value) => json(res, 200, value)) },
    { method: 'POST', pattern: '/api/qzone/login', handler: ({ res, json }) => service.login().then((value) => json(res, 200, value)) },
    { method: 'POST', pattern: '/api/qzone/read', handler: ({ res, json }) => service.readNow().then((value) => json(res, 200, value)) }
  ];
}
