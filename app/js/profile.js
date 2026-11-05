// 名前と音量を、このブラウザに保存する（保存できないブラウザでも遊べるようにする）
const KEY = 'uchikaeshi.profile.v1';

export function loadProfile() {
  const p = { name: '', volume: 0.8 };
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (typeof s.name === 'string') p.name = s.name.slice(0, 10);
    if (typeof s.volume === 'number' && s.volume >= 0 && s.volume <= 1) p.volume = s.volume;
  } catch { /* 読めなければ初期値 */ }
  return p;
}

export function saveProfile(p) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* 保存できなくても続ける */ }
}
