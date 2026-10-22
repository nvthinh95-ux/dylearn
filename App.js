import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, Image, ScrollView,
  ActivityIndicator, Alert, StyleSheet, SafeAreaView, StatusBar, Platform, Modal,
} from 'react-native';
import { WebView } from 'react-native-webview';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import AsyncStorage from '@react-native-async-storage/async-storage';

const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
const HEADERS = { 'User-Agent': UA, Referer: 'https://www.douyin.com/' };

const getId = (s) =>
  ((s || '').match(/video\/(\d{8,})/) || [])[1] ||
  ((s || '').match(/modal_id=(\d{8,})/) || [])[1];

async function resolveVideo(link) {
  let id = getId(link);
  if (!id) {
    const r = await fetch(link, { headers: { 'User-Agent': UA } });
    id = getId(r.url);
  }
  if (!id) throw new Error('Không lấy được ID video từ link này.');

  const res = await fetch(`https://www.iesdouyin.com/share/video/${id}/`, {
    headers: { 'User-Agent': UA },
  });
  const html = await res.text();
  const mm = html.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
  if (!mm) throw new Error('Douyin không trả dữ liệu (bị chặn hoặc video riêng tư).');
  const data = JSON.parse(mm[1]);
  let item = null;
  const loader = data.loaderData || {};
  for (const k of Object.keys(loader)) {
    const it = loader[k]?.videoInfoRes?.item_list?.[0];
    if (it) { item = it; break; }
  }
  if (!item) throw new Error('Không tìm thấy video (có thể đã bị xóa).');

  const v = item.video;
  const uri = v.play_addr.uri;
  const fallback = (v.play_addr.url_list?.[0] || '').replace('/playwm/', '/play/');
  const q = (ratio) =>
    `https://aweme.snssdk.com/aweme/v1/play/?video_id=${uri}&ratio=${ratio}&line=0`;

  const options = [
    { label: '1080p', url: q('1080p'), fallback },
    { label: '720p', url: q('720p'), fallback },
    { label: '540p', url: q('540p'), fallback },
    { label: 'Mặc định', url: fallback, fallback },
  ];
  const pu = item.music?.play_url;
  const musicUrl = pu?.url_list?.[0] || (pu?.uri && pu.uri.startsWith('http') ? pu.uri : null);
  if (musicUrl) options.push({ label: 'Nhạc', url: musicUrl, audio: true });

  return { id, title: item.desc || `Video ${id}`, cover: v.cover?.url_list?.[0], options };
}


const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Chạy trong trang web kênh: tự cuộn và gom ID video từ các thẻ <a href=".../video/ID">
const INJECT = `
(function(){
  if (window.__dy) return; window.__dy = true;
  var ids = {};
  function post(list){ window.ReactNativeWebView.postMessage(JSON.stringify({type:'progress', data:list})); }
  function scan(){
    var a = document.querySelectorAll('a[href*="/video/"]');
    for (var i=0;i<a.length;i++){
      var h = a[i].getAttribute('href') || '';
      var m = (h.split('/video/')[1] || '').match(/^[0-9]{8,}/);
      if (m) ids[m[0]] = true;
    }
    return Object.keys(ids);
  }
  setInterval(function(){
    post(scan());
    window.scrollTo(0, 10000000);
    if (document.documentElement) document.documentElement.scrollTop = 10000000;
  }, 1200);
})();
true;
`;

export default function App() {
  const [text, setText] = useState('');
  const [items, setItems] = useState([]);
  const [history, setHistory] = useState([]);
  const [bulk, setBulk] = useState('720p');
  const [running, setRunning] = useState(false);
  const [channelText, setChannelText] = useState('');
  const [maxVideos, setMaxVideos] = useState('30');
  const [chanUri, setChanUri] = useState(null);
  const [collected, setCollected] = useState([]);
  const doneRef = useRef(false);

  useEffect(() => {
    AsyncStorage.getItem('history').then((s) => s && setHistory(JSON.parse(s)));
  }, []);

  const upd = (key, patch) =>
    setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...patch } : i)));

  const paste = async () => {
    const t = await Clipboard.getStringAsync();
    if (t) setText((old) => (old ? old + '\n' + t : t));
  };

  const enqueue = async (urls) => {
    const base = Date.now();
    const fresh = urls.map((u, n) => ({ key: `${base}_${n}`, link: u, status: 'fetching', progress: 0 }));
    setItems((prev) => [...fresh, ...prev]);
    for (let n = 0; n < fresh.length; n++) {
      const it = fresh[n];
      try {
        const info = await resolveVideo(it.link);
        upd(it.key, { ...info, status: 'ready' });
      } catch (e) {
        upd(it.key, { status: 'error', error: e.message });
      }
      if (fresh.length > 1) await new Promise((r) => setTimeout(r, 350));
    }
  };

  const addLinks = async () => {
    const urls = [...new Set(text.match(/https?:\/\/[^\s\u4e00-\u9fff]+/g) || [])];
    if (!urls.length) { Alert.alert('Lỗi', 'Không thấy link nào trong nội dung đã dán.'); return; }
    setText('');
    enqueue(urls);
  };

  const limit = () => Math.max(1, Math.min(200, parseInt(maxVideos, 10) || 30));

  const openChannel = async () => {
    const m = channelText.match(/https?:\/\/[^\s\u4e00-\u9fff]+/);
    const raw = m ? m[0] : channelText.trim();
    const pick = (s) => (s.match(/user\/([A-Za-z0-9_-]{20,})/) || [])[1] || (s.match(/sec_uid=([A-Za-z0-9_-]{20,})/) || [])[1];
    let secUid = pick(raw) || (/^MS4w[A-Za-z0-9_-]+$/.test(raw) ? raw : null);
    if (!secUid && m) {
      try {
        const r = await fetch(m[0], { headers: { 'User-Agent': UA } });
        secUid = pick(r.url);
      } catch (e) {}
    }
    if (!secUid) { Alert.alert('Lỗi', 'Không nhận ra link kênh. Hãy dán link chia sẻ trang cá nhân (kênh) Douyin.'); return; }
    doneRef.current = false;
    setCollected([]);
    setChanUri(`https://www.douyin.com/user/${secUid}`);
  };

  const finishChannel = (ids) => {
    if (doneRef.current) return;
    if (!ids.length) { Alert.alert('Chưa gom được video nào', 'Đợi trang tải xong, hoặc xử lý captcha/đăng nhập trong khung rồi bấm Xong lại.'); return; }
    doneRef.current = true;
    setChanUri(null);
    setChannelText('');
    enqueue(ids.map((id) => `https://www.douyin.com/video/${id}`));
  };

  const onWebMsg = (e) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data);
      if (msg.type === 'progress') {
        setCollected(msg.data);
        if (msg.data.length >= limit()) finishChannel(msg.data.slice(0, limit()));
      }
    } catch (err) {}
  };

  const saveHistory = async (entry) => {
    setHistory((h) => {
      const next = [entry, ...h].slice(0, 100);
      AsyncStorage.setItem('history', JSON.stringify(next));
      return next;
    });
  };

  const downloadItem = async (it, opt) => {
    const key = it.key;
    try {
      const perm = await MediaLibrary.requestPermissionsAsync(true);
      if (!perm.granted) throw new Error('Cần cấp quyền lưu vào thư viện.');
      const ext = opt.audio ? 'mp3' : 'mp4';
      const minSize = opt.audio ? 10 * 1024 : 50 * 1024;
      const path = `${FileSystem.cacheDirectory}dy_${it.id}_${opt.label}.${ext}`;
      upd(key, { status: 'downloading', progress: 0, mb: 0, label: opt.label, error: null });

      const attempt = async (url) => {
        let lastPct = -2;
        let lastMb = -1;
        const dl = FileSystem.createDownloadResumable(url, path, { headers: HEADERS }, (p) => {
          const total = p.totalBytesExpectedToWrite;
          const pct = total > 0 ? Math.floor((p.totalBytesWritten / total) * 100) : -1;
          const mb = Math.round((p.totalBytesWritten / 1048576) * 10) / 10;
          if (pct !== lastPct || mb !== lastMb) {
            lastPct = pct; lastMb = mb;
            upd(key, { progress: pct, mb });
          }
        });
        const r = await dl.downloadAsync();
        const info = await FileSystem.getInfoAsync(r.uri);
        if (r.status !== 200 || !info.exists || info.size < minSize) {
          throw new Error('Tải thất bại (' + r.status + ')');
        }
        return r.uri;
      };

      let local;
      try { local = await attempt(opt.url); }
      catch (e) {
        if (opt.audio || !opt.fallback) throw e;
        local = await attempt(opt.fallback);
      }
      await MediaLibrary.saveToLibraryAsync(local);
      upd(key, { status: 'done', progress: 100 });
      saveHistory({ id: it.id + opt.label + Date.now(), title: it.title, label: opt.label, date: new Date().toLocaleString() });
    } catch (e) {
      upd(key, { status: 'error', error: e.message });
    }
  };

  const downloadAll = async () => {
    const todo = items.filter((i) => i.status === 'ready');
    if (!todo.length) { Alert.alert('Chưa có video nào sẵn sàng để tải.'); return; }
    setRunning(true);
    for (const it of todo) {
      const opt = it.options.find((o) => o.label === bulk) ||
        (bulk === 'Nhạc' ? null : it.options.find((o) => !o.audio));
      if (!opt) { upd(it.key, { status: 'error', error: 'Video này không có nhạc riêng.' }); continue; }
      await downloadItem(it, opt);
    }
    setRunning(false);
  };

  const renderItem = (it) => (
    <View key={it.key} style={s.card}>
      <View style={s.cardTop}>
        {it.cover ? <Image source={{ uri: it.cover }} style={s.thumb} /> : <View style={[s.thumb, { backgroundColor: '#333' }]} />}
        <View style={{ flex: 1 }}>
          <Text style={s.title} numberOfLines={2}>{it.title || it.link}</Text>
          {it.status === 'fetching' && <Text style={s.sub}>Đang lấy thông tin...</Text>}
          {it.status === 'ready' && <Text style={s.sub}>Sẵn sàng, chọn chất lượng</Text>}
          {it.status === 'done' && <Text style={[s.sub, { color: '#4cd964' }]}>Đã lưu ({it.label}) ✓</Text>}
          {it.status === 'error' && <Text style={[s.sub, { color: '#ff6b6b' }]}>Lỗi: {it.error}</Text>}
        </View>
        <TouchableOpacity onPress={() => setItems((p) => p.filter((x) => x.key !== it.key))} disabled={it.status === 'downloading'}>
          <Text style={s.x}>✕</Text>
        </TouchableOpacity>
      </View>

      {it.status === 'downloading' && (
        <View style={{ marginTop: 10 }}>
          <View style={s.barBg}>
            <View style={[s.barFill, { width: it.progress >= 0 ? `${it.progress}%` : '30%' }]} />
          </View>
          <Text style={s.sub}>
            {it.label}: {it.progress >= 0 ? `${it.progress}%` : 'đang tải'} · {it.mb} MB
          </Text>
        </View>
      )}

      {(it.status === 'ready' || it.status === 'done' || (it.status === 'error' && it.options)) && (
        <View style={s.opts}>
          {it.options.map((o) => (
            <TouchableOpacity key={o.label} style={s.opt} onPress={() => downloadItem(it, o)} disabled={running}>
              <Text style={s.btnT}>{o.audio ? '♪ Nhạc' : o.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );

  const labels = ['1080p', '720p', '540p', 'Mặc định', 'Nhạc'];

  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="light-content" />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={s.head}>
          <Text style={s.brand}>Adgen747</Text>
          <Text style={s.tagline}>bố yêu 2 mẹ con nhà mụp</Text>
        </View>
        <TextInput
          style={s.input}
          placeholder="Dán 1 hoặc nhiều link Douyin (mỗi link 1 dòng)"
          placeholderTextColor="#777"
          value={text}
          onChangeText={setText}
          multiline
        />
        <View style={s.row}>
          <TouchableOpacity style={s.btnAlt} onPress={paste}><Text style={s.btnT}>Dán</Text></TouchableOpacity>
          <TouchableOpacity style={[s.btn, { flex: 1 }]} onPress={addLinks}><Text style={s.btnT}>Thêm vào danh sách</Text></TouchableOpacity>
        </View>


        <View style={s.bulk}>
          <Text style={s.sub}>Tải cả kênh: dán link trang cá nhân (kênh) Douyin</Text>
          <TextInput
            style={[s.input, { minHeight: 0 }]}
            placeholder="Link kênh (v.douyin.com/... hoặc douyin.com/user/...)"
            placeholderTextColor="#777"
            value={channelText}
            onChangeText={setChannelText}
          />
          <View style={s.row}>
            <View style={{ flex: 1 }}>
              <Text style={s.sub}>Số video tối đa</Text>
              <TextInput style={[s.input, { minHeight: 0 }]} value={maxVideos} onChangeText={setMaxVideos} keyboardType="numeric" />
            </View>
            <TouchableOpacity style={[s.btn, { flex: 2, justifyContent: 'center' }]} onPress={openChannel}>
              <Text style={s.btnT}>Mở kênh & gom video</Text>
            </TouchableOpacity>
          </View>
        </View>

        {items.length > 0 && (
          <View style={s.bulk}>
            <Text style={s.sub}>Tải tất cả với:</Text>
            <View style={s.opts}>
              {labels.map((l) => (
                <TouchableOpacity key={l} style={[s.chip, bulk === l && s.chipOn]} onPress={() => setBulk(l)}>
                  <Text style={s.btnT}>{l === 'Nhạc' ? '♪ Nhạc' : l}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity style={[s.btn, running && { opacity: 0.5 }]} onPress={downloadAll} disabled={running}>
              {running ? <ActivityIndicator color="#fff" /> : <Text style={s.btnT}>Tải tất cả</Text>}
            </TouchableOpacity>
          </View>
        )}

        {items.map(renderItem)}

        <Text style={s.h2}>Lịch sử tải</Text>
        {history.length === 0 && <Text style={s.sub}>Chưa có video nào.</Text>}
        {history.slice(0, 30).map((h) => (
          <View key={h.id} style={s.hi}>
            <Text style={s.hiT} numberOfLines={1}>{h.title}</Text>
            <Text style={s.sub}>{h.label} · {h.date}</Text>
          </View>
        ))}
      </ScrollView>

      <Modal visible={!!chanUri} animationType="slide" onRequestClose={() => setChanUri(null)}>
        <SafeAreaView style={[s.root, { padding: 0 }]}>
          <View style={s.modalBar}>
            <Text style={[s.btnT, { flex: 1 }]}>Đang gom: {collected.length}/{limit()} video</Text>
            <TouchableOpacity style={s.btnAlt} onPress={() => setChanUri(null)}><Text style={s.btnT}>Đóng</Text></TouchableOpacity>
            <TouchableOpacity style={[s.btn, { paddingVertical: 10, marginLeft: 8 }]} onPress={() => finishChannel(collected.slice(0, limit()))}>
              <Text style={s.btnT}>Xong</Text>
            </TouchableOpacity>
          </View>
          <Text style={[s.sub, { paddingHorizontal: 12 }]}>App tự cuộn trang. Nếu hiện captcha hoặc đăng nhập, xử lý ngay trong khung này.</Text>
          {chanUri && (
            <WebView
              source={{ uri: chanUri }}
              userAgent={DESKTOP_UA}
              injectedJavaScript={INJECT}
              onMessage={onWebMsg}
              javaScriptEnabled
              domStorageEnabled
              thirdPartyCookiesEnabled
              sharedCookiesEnabled
              originWhitelist={['*']}
              onShouldStartLoadWithRequest={(r) => /^https?:/i.test(r.url)}
              style={{ flex: 1, backgroundColor: '#000' }}
            />
          )}
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000', padding: 16, paddingTop: Platform.OS === 'android' ? 40 : 16 },
  head: { alignItems: 'center', marginBottom: 18, marginTop: 4 },
  brand: { color: '#fff', fontSize: 46, fontWeight: '900', letterSpacing: 1, textShadowColor: '#fe2c55', textShadowOffset: { width: 3, height: 3 }, textShadowRadius: 1 },
  tagline: { color: '#aaa', fontSize: 12, fontStyle: 'italic', marginTop: 2 },
  h2: { color: '#fff', fontSize: 16, fontWeight: '600', marginTop: 20, marginBottom: 8 },
  row: { flexDirection: 'row', gap: 8, marginTop: 8 },
  input: { backgroundColor: '#1c1c1e', color: '#fff', padding: 12, borderRadius: 10, minHeight: 80, textAlignVertical: 'top' },
  btn: { backgroundColor: '#fe2c55', padding: 14, borderRadius: 10, alignItems: 'center' },
  btnAlt: { backgroundColor: '#333', paddingHorizontal: 18, borderRadius: 10, justifyContent: 'center' },
  btnT: { color: '#fff', fontWeight: '600' },
  bulk: { backgroundColor: '#111', borderRadius: 12, padding: 12, marginTop: 12, gap: 8 },
  chip: { backgroundColor: '#222', paddingVertical: 8, paddingHorizontal: 14, borderRadius: 20 },
  chipOn: { backgroundColor: '#fe2c55' },
  card: { backgroundColor: '#1c1c1e', borderRadius: 12, padding: 12, marginTop: 12 },
  cardTop: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  thumb: { width: 60, height: 80, borderRadius: 6 },
  title: { color: '#fff', marginBottom: 4 },
  sub: { color: '#999', fontSize: 12, marginTop: 2 },
  x: { color: '#888', fontSize: 18, paddingHorizontal: 6 },
  barBg: { height: 8, backgroundColor: '#333', borderRadius: 4, overflow: 'hidden', marginBottom: 4 },
  barFill: { height: 8, backgroundColor: '#25f4ee', borderRadius: 4 },
  opts: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  opt: { backgroundColor: '#25f4ee22', borderColor: '#25f4ee', borderWidth: 1, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8 },
  modalBar: { flexDirection: 'row', alignItems: 'center', padding: 12, paddingTop: Platform.OS === 'android' ? 40 : 12 },
  hi: { paddingVertical: 8, borderBottomColor: '#222', borderBottomWidth: 1 },
  hiT: { color: '#fff' },
});
