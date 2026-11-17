export async function contactChoices({ kind, onebot, inbox, store, config }) {
  const groups = kind === 'groups', field = groups ? 'groups' : 'friends', prefix = groups ? 'group:' : 'private:';
  const known = new Map();
  const add = (id, name, source) => {
    id = String(id || '').trim(); if (!/^\d{1,15}$/.test(id)) return;
    const previous = known.get(id);
    known.set(id, { id, name: String(name || previous?.name || id), source });
  };
  for (const id of (groups ? config.allow?.groups : config.allow?.private) || []) add(id, '', 'configured');
  for (const key of store?.listChats?.() || []) if (key.startsWith(prefix)) {
    const recent = store.recent(key, {limit:1, includeSelf:false})[0];
    add(key.slice(prefix.length), groups ? '' : recent?.senderName, 'recent');
  }
  for (const chat of inbox?.listChats?.() || []) if (chat.chatKey.startsWith(prefix)) add(chat.chatKey.slice(prefix.length), groups ? '' : chat.senderName, 'recent');
  try {
    const value = await onebot.call(groups ? 'get_group_list' : 'get_friend_list');
    const list = Array.isArray(value) ? value : value?.data;
    if (!Array.isArray(list)) throw new Error('联系人接口返回格式不正确');
    for (const item of list) add(groups ? item.group_id : item.user_id, groups ? item.group_name : (item.remark || item.nickname), 'qq');
    return { [field]: [...known.values()], complete: true, source: 'qq', notice: '' };
  } catch (error) {
    const unsupported = error.httpStatus === 501 || error.code === 'NATIVE_ACTION_NOT_IMPLEMENTED' || /NATIVE_ACTION_NOT_IMPLEMENTED|HTTP 501/.test(error.message);
    return { [field]: [...known.values()], complete: false, source: 'local', code: unsupported ? 'CONTACT_LIST_UNSUPPORTED' : 'CONTACT_LIST_UNAVAILABLE', notice: unsupported ? `当前 Alcor 核心尚不支持读取完整${groups ? '群' : '好友'}列表。这里显示最近联系人和已配置号码，也可手动添加。` : `暂时无法读取 QQ 联系人，已显示本地记录。可以手动添加号码。原因：${error.message}` };
  }
}
