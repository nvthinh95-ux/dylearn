import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, Image, FlatList,
  ActivityIndicator, Alert, StyleSheet, SafeAreaView, StatusBar, Platform,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import AsyncStorage from '@react-native-async-storage/async-storage';

const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

const getId = (s) =>
  ((s || '').match(/video\/(\d{8,})/) || [])[1] ||
  ((s || '').match(/modal_id=(\d{8,})/) || [])[1];

async function resolveVideo(input) {
  const m = input.match(/https?:\/\/[^\s]+/);
  if (!m) throw new Error('Không thấy link trong nội dung đã dán.');
  const link = m[0];
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
  if (!mm) throw new Error('Douyin không trả dữ liệu (có thể bị chặn hoặc video riêng tư).');
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

  return {
    id,
    title: item.desc || `Video ${id}`,
    cover: v.cover?.url_list?.[0],
    options: [
      { label: '1080p', url: q('1080p'), fallback },
      { label: '720p', url: q('720p'), fallback },
      { label: '540p', url: q('540p'), fallback },
      { label: 'Mặc định', url: fallback, fallback },
    ],
  };
}

async function tryDownload(url, path) {
  const r = await FileSystem.downloadAsync(url, path, {
    headers: { 'User-Agent': UA, Referer: 'https://www.douyin.com/' },
  });
  const info = await FileSystem.getInfoAsync(r.uri);
  if (r.status !== 200 || !info.exists || info.size < 50 * 1024) {
    throw new Error('Tải thất bại (' + r.status + ')');
  }
  return r.uri;
}

export default function App() {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [video, setVideo] = useState(null);
  const [history, setHistory] = useState([]);

  useEffect(() => {
    AsyncStorage.getItem('history').then((s) => s && setHistory(JSON.parse(s)));
  }, []);

  const paste = async () => {
    const t = await Clipboard.getStringAsync();
    if (t) { setText(t); fetchInfo(t); }
  };

  const fetchInfo = async (input = text) => {
    setBusy(true); setVideo(null);
    try { setVideo(await resolveVideo(input)); }
    catch (e) { Alert.alert('Lỗi', e.message); }
    setBusy(false);
  };

  const download = async (opt) => {
    setBusy(true);
    try {
      const perm = await MediaLibrary.requestPermissionsAsync(true);
      if (!perm.granted) throw new Error('Cần cấp quyền lưu vào thư viện.');
      const path = `${FileSystem.cacheDirectory}dy_${video.id}_${opt.label}.mp4`;
      let local;
      try { local = await tryDownload(opt.url, path); }
      catch { local = await tryDownload(opt.fallback, path); }
      await MediaLibrary.saveToLibraryAsync(local);
      const entry = { id: video.id + opt.label, title: video.title, label: opt.label, date: new Date().toLocaleString() };
      const next = [entry, ...history].slice(0, 100);
      setHistory(next);
      await AsyncStorage.setItem('history', JSON.stringify(next));
      Alert.alert('Xong', 'Đã lưu video vào thư viện.');
    } catch (e) { Alert.alert('Lỗi', e.message); }
    setBusy(false);
  };

  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="light-content" />
      <Text style={s.h1}>DyLearn</Text>
      <View style={s.row}>
        <TextInput
          style={s.input}
          placeholder="Dán link Douyin vào đây"
          placeholderTextColor="#777"
          value={text}
          onChangeText={setText}
        />
        <TouchableOpacity style={s.btnAlt} onPress={paste}><Text style={s.btnT}>Dán</Text></TouchableOpacity>
      </View>
      <TouchableOpacity style={s.btn} onPress={() => fetchInfo()} disabled={busy}>
        <Text style={s.btnT}>Lấy thông tin</Text>
      </TouchableOpacity>
      {busy && <ActivityIndicator style={{ margin: 12 }} color="#fff" />}

      {video && (
        <View style={s.card}>
          {video.cover && <Image source={{ uri: video.cover }} style={s.cover} />}
          <Text style={s.title} numberOfLines={3}>{video.title}</Text>
          <View style={s.opts}>
            {video.options.map((o) => (
              <TouchableOpacity key={o.label} style={s.opt} onPress={() => download(o)} disabled={busy}>
                <Text style={s.btnT}>{o.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}

      <Text style={s.h2}>Lịch sử tải</Text>
      <FlatList
        data={history}
        keyExtractor={(i) => i.id + i.date}
        renderItem={({ item }) => (
          <View style={s.hi}>
            <Text style={s.hiT} numberOfLines={1}>{item.title}</Text>
            <Text style={s.hiS}>{item.label} · {item.date}</Text>
          </View>
        )}
        ListEmptyComponent={<Text style={s.hiS}>Chưa có video nào.</Text>}
      />
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000', padding: 16, paddingTop: Platform.OS === 'android' ? 40 : 16 },
  h1: { color: '#fff', fontSize: 26, fontWeight: '700', marginBottom: 12 },
  h2: { color: '#fff', fontSize: 16, fontWeight: '600', marginTop: 16, marginBottom: 8 },
  row: { flexDirection: 'row', gap: 8 },
  input: { flex: 1, backgroundColor: '#1c1c1e', color: '#fff', padding: 12, borderRadius: 10 },
  btn: { backgroundColor: '#fe2c55', padding: 14, borderRadius: 10, alignItems: 'center', marginTop: 8 },
  btnAlt: { backgroundColor: '#333', paddingHorizontal: 16, borderRadius: 10, justifyContent: 'center' },
  btnT: { color: '#fff', fontWeight: '600' },
  card: { backgroundColor: '#1c1c1e', borderRadius: 12, padding: 12, marginTop: 12 },
  cover: { width: '100%', height: 180, borderRadius: 8, marginBottom: 8 },
  title: { color: '#fff', marginBottom: 10 },
  opts: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  opt: { backgroundColor: '#25f4ee22', borderColor: '#25f4ee', borderWidth: 1, paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8 },
  hi: { paddingVertical: 8, borderBottomColor: '#222', borderBottomWidth: 1 },
  hiT: { color: '#fff' },
  hiS: { color: '#888', fontSize: 12, marginTop: 2 },
});
