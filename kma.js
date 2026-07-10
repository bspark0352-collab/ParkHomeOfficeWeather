// api/kma.js
// Vercel Serverless Function: 기상청(KMA) 단기예보(getVilageFcst)를 중계한다.
// 브라우저에서 기상청 API를 직접 호출하면 CORS로 막히기 때문에, 이 함수가 대신 호출하고
// 결과를 앱이 쓰기 좋은 형태(시간별 배열)로 정리해서 돌려준다.
// API 인증키는 코드에 직접 넣지 않고 Vercel 환경변수(KMA_API_KEY)에서 읽는다.

function latLonToGrid(lat, lon) {
  // 기상청 공식 격자변환(Lambert Conformal Conic) 알고리즘
  const RE = 6371.00877, GRID = 5.0;
  const SLAT1 = 30.0, SLAT2 = 60.0, OLON = 126.0, OLAT = 38.0, XO = 43, YO = 136;
  const DEGRAD = Math.PI / 180.0;

  const re = RE / GRID;
  const slat1 = SLAT1 * DEGRAD;
  const slat2 = SLAT2 * DEGRAD;
  const olon = OLON * DEGRAD;
  const olat = OLAT * DEGRAD;

  let sn = Math.tan(Math.PI * 0.25 + slat2 * 0.5) / Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn);
  let sf = Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sf = (Math.pow(sf, sn) * Math.cos(slat1)) / sn;
  let ro = Math.tan(Math.PI * 0.25 + olat * 0.5);
  ro = (re * sf) / Math.pow(ro, sn);

  let ra = Math.tan(Math.PI * 0.25 + (lat * DEGRAD) * 0.5);
  ra = (re * sf) / Math.pow(ra, sn);
  let theta = lon * DEGRAD - olon;
  if (theta > Math.PI) theta -= 2 * Math.PI;
  if (theta < -Math.PI) theta += 2 * Math.PI;
  theta *= sn;

  const x = Math.floor(ra * Math.sin(theta) + XO + 0.5);
  const y = Math.floor(ro - ra * Math.cos(theta) + YO + 0.5);
  return { nx: x, ny: y };
}

function pad2(n) { return String(n).padStart(2, '0'); }

function getKstNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
}

// 기상청 단기예보는 하루 8회(02,05,08,11,14,17,20,23시) 발표된다.
// 발표 후 약 10~15분 뒤부터 조회 가능하므로, 현재 시각 기준 가장 최근에
// "발표되어 조회 가능한" 시각을 찾는다.
function pickBaseDateTime(now) {
  const slots = [2, 5, 8, 11, 14, 17, 20, 23];
  const y = now.getFullYear(), mo = now.getMonth(), d = now.getDate();
  const nowMin = now.getHours() * 60 + now.getMinutes();

  let chosenSlot = null;
  for (let i = slots.length - 1; i >= 0; i--) {
    if (nowMin >= slots[i] * 60 + 15) { chosenSlot = slots[i]; break; }
  }
  let chosenDate = new Date(y, mo, d);
  if (chosenSlot === null) {
    chosenSlot = 23;
    chosenDate = new Date(y, mo, d - 1);
  }
  const baseDate = `${chosenDate.getFullYear()}${pad2(chosenDate.getMonth() + 1)}${pad2(chosenDate.getDate())}`;
  const baseTime = `${pad2(chosenSlot)}00`;
  return { baseDate, baseTime };
}

// SKY(하늘상태) + PTY(강수형태) -> 앱 내부 날씨 코드로 변환
// (기존 Open-Meteo 기반 코드 체계를 그대로 재사용, 68/69는 비/눈 혼합용 확장 코드)
function toWeatherCode(sky, pty) {
  const p = Number(pty);
  if (p === 1) return 61; // 비
  if (p === 2) return 68; // 비/눈
  if (p === 3) return 71; // 눈
  if (p === 4) return 80; // 소나기
  if (p === 5) return 51; // 빗방울
  if (p === 6) return 69; // 빗방울눈날림
  if (p === 7) return 77; // 눈날림
  const s = Number(sky);
  if (s === 1) return 0;  // 맑음
  if (s === 3) return 2;  // 구름많음
  if (s === 4) return 3;  // 흐림
  return 1;
}

module.exports = async (req, res) => {
  try {
    const { lat, lon } = req.query;
    if (!lat || !lon) {
      res.status(400).json({ error: 'lat, lon 파라미터가 필요합니다.' });
      return;
    }
    const apiKey = process.env.KMA_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: 'KMA_API_KEY 환경변수가 설정되지 않았습니다.' });
      return;
    }

    const { nx, ny } = latLonToGrid(parseFloat(lat), parseFloat(lon));
    const now = getKstNow();
    const { baseDate, baseTime } = pickBaseDateTime(now);

    const url = `https://apihub.kma.go.kr/api/typ02/openApi/VilageFcstInfoService_2.0/getVilageFcst` +
      `?pageNo=1&numOfRows=1000&dataType=JSON&base_date=${baseDate}&base_time=${baseTime}` +
      `&nx=${nx}&ny=${ny}&authKey=${apiKey}`;

    const resp = await fetch(url);
    if (!resp.ok) {
      res.status(502).json({ error: `기상청 API 응답 오류 (${resp.status})` });
      return;
    }
    const data = await resp.json();
    const header = data && data.response && data.response.header;
    if (!header || header.resultCode !== '00') {
      res.status(502).json({ error: `기상청 API 오류: ${header ? header.resultMsg : '알 수 없는 응답'}` });
      return;
    }
    const items = (data.response.body && data.response.body.items && data.response.body.items.item) || [];

    const byTime = {};
    for (const it of items) {
      const key = `${it.fcstDate}-${it.fcstTime}`;
      if (!byTime[key]) byTime[key] = { date: it.fcstDate, time: it.fcstTime };
      byTime[key][it.category] = it.fcstValue;
    }

    const hourly = Object.values(byTime).map(row => {
      const y = row.date.slice(0, 4), mo = row.date.slice(4, 6), d = row.date.slice(6, 8);
      const hour = parseInt(row.time.slice(0, 2), 10);
      if (row.TMP === undefined) return null;
      const temp = parseFloat(row.TMP);
      const prob = row.POP !== undefined ? parseInt(row.POP, 10) : null;
      let precip = 0;
      if (row.PCP && row.PCP !== '강수없음' && row.PCP !== '0') {
        const m = String(row.PCP).match(/[\d.]+/);
        precip = m ? parseFloat(m[0]) : 0;
      }
      const code = toWeatherCode(row.SKY, row.PTY);
      const isDay = (hour >= 6 && hour < 19) ? 1 : 0;
      return { date: `${y}-${mo}-${d}`, hour, temp, precip, prob, code, isDay };
    }).filter(Boolean).sort((a, b) =>
      (a.date + pad2(a.hour)).localeCompare(b.date + pad2(b.hour))
    );

    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=300');
    res.status(200).json({ nx, ny, baseDate, baseTime, hourly });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
};
