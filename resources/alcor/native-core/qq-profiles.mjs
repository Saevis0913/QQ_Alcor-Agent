/** Exact shipped QQ module identities. Numeric addresses are RVAs, never process pointers.
 * 9.9.37: static ABI comparison completed; live account roundtrip remains to be verified.
 * See docs/qq-9.9.37-compatibility.md. Never authorize by display version alone. */
const profiles = [
  {
    version:'9.9.36-53644', module:'wrapper.node', architecture:'x64', verification:'live',
    sha256:'0d8b94448f4dafe7337b88d6a568b004224c37fcbe2bd1142c1af7624fbd534c',
    rvas:{service_getter:0x74f214,release:0x1db2,string_construct:0x77d510,string_destroy:0x77d200,
      callback_move:0x321626,callback_present:0x407742,callback_destroy:0x263c,
      service_global:0x69c6300,core_global:0x69c6428,service_vtable:0x40fff58,core_vtable:0x4102c18,
      account_pair:0x69c92b8,send:0x753fe6,receive:0x1c14718}
  },
  {
    version:'9.9.37-54395', module:'wrapper.node', architecture:'x64', verification:'static',
    sha256:'fed532ad58d2404dcedf2858554e8fa52a5f4e65b271c008d2faca4011d7d4a2',
    rvas:{service_getter:0x761094,release:0x1db2,string_construct:0x78ef10,string_destroy:0x78ec00,
      callback_move:0x325ae8,callback_present:0x40e1d2,callback_destroy:0x263c,
      service_global:0x6a104a8,core_global:0x6a105d0,service_vtable:0x412fd88,core_vtable:0x4132a48,
      account_pair:0x6a13468,send:0x765d70,receive:0x1c39de8}
  }
];
export const QQ_BUILD_PROFILES=Object.freeze(profiles.map(p=>Object.freeze({...p,rvas:Object.freeze(p.rvas)})));
export function findQQBuildProfile(moduleName,sha256){
  if(typeof moduleName!=='string'||typeof sha256!=='string'||!/^([a-f0-9]{64})$/i.test(sha256))return null;
  return QQ_BUILD_PROFILES.find(p=>p.module===moduleName.toLowerCase()&&p.sha256===sha256.toLowerCase())||null;
}
export function renderQQProfilesHeader(entries=QQ_BUILD_PROFILES){
  const fields=Object.keys(QQ_BUILD_PROFILES[0].rvas),seen=new Set();
  if(!Array.isArray(entries)||!entries.length)throw Error('INVALID_QQ_PROFILES');
  for(const p of entries){
    if(!/^[a-f0-9]{64}$/.test(p.sha256)||!/^\d+\.\d+\.\d+-\d+$/.test(p.version)||p.module!=='wrapper.node'||p.architecture!=='x64')throw Error('INVALID_QQ_PROFILE');
    if(seen.has(p.sha256))throw Error('DUPLICATE_QQ_BUILD');seen.add(p.sha256);
    if(!p.rvas||Object.keys(p.rvas).length!==fields.length||fields.some(f=>!Number.isSafeInteger(p.rvas[f])||p.rvas[f]<1||p.rvas[f]>=0x10000000))throw Error('INVALID_QQ_RVA');
  }
  const rows=entries.map(p=>`  {"${p.version}","${p.sha256}",{${p.sha256.match(/../g).map(b=>'0x'+b).join(',')}},${fields.map(f=>'0x'+p.rvas[f].toString(16)).join(',')}}`).join(',\n');
  return `/* Generated from native-core/qq-profiles.mjs. Do not edit. */
#ifndef ALCOR_QQ_PROFILES_GENERATED_H
#define ALCOR_QQ_PROFILES_GENERATED_H
#include <stdint.h>
#include <stddef.h>
#include <string.h>
typedef struct lb_qq_profile {
  const char *version; const char *sha256; uint8_t digest[32];
${fields.map(f=>'  uintptr_t '+f+';').join('\n')}
} lb_qq_profile;
static const lb_qq_profile lb_qq_profiles[]={
${rows}
};
static inline const lb_qq_profile *lb_qq_profile_for_hash(const uint8_t digest[32]) {
  if(!digest)return NULL;
  for(size_t i=0;i<sizeof(lb_qq_profiles)/sizeof(lb_qq_profiles[0]);i++)
    if(!memcmp(digest,lb_qq_profiles[i].digest,32))return &lb_qq_profiles[i];
  return NULL;
}
#endif
`;
}
