// 최종 보고서 종이 양식(B4) PDF를 만든다. 질문·안내·예시는 public/app.js의 REPORT_QS를 그대로 읽어 온다.
//   npm i --no-save playwright pretendard && node print/build.js
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const m = src.match(/const REPORT_QS = (\[[\s\S]*?\n\]);/);
if (!m) throw new Error('public/app.js에서 REPORT_QS를 찾지 못했습니다.');
const QS = new Function(`return ${m[1]}`)();

const fontDir = path.join(path.dirname(require.resolve('pretendard/package.json')), 'dist/web/static/woff2');
const font = w => pathToFileURL(path.join(fontDir, `Pretendard-${w}.woff2`)).href;
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const head = (title, sub) => `
  <header>
    <div><h1>${title}</h1><p>${sub}</p></div>
    <table class="id"><tr><th>팀명</th><td class="w"></td><th>학번</th><td></td><th>이름</th><td></td></tr></table>
  </header>`;

const question = (q, i) => `
  <section class="q">
    <h2><span>${i + 1}</span>${esc(q.title)}</h2>
    <p class="guide">${esc(q.guide)}</p>
    ${q.frames ? `<ul class="frames">${q.frames.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
    <div class="lines"></div>
  </section>`;

const half = Math.ceil(QS.length / 2);
const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>
  @font-face { font-family: P; font-weight: 400; src: url("${font('Regular')}"); }
  @font-face { font-family: P; font-weight: 600; src: url("${font('SemiBold')}"); }
  @font-face { font-family: P; font-weight: 800; src: url("${font('ExtraBold')}"); }
  @page { size: 257mm 364mm; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: P, sans-serif; font-size: 11pt; line-height: 1.5; color: #111; word-break: keep-all; }
  .page { width: 257mm; height: 364mm; padding: 13mm 14mm 11mm; display: flex; flex-direction: column; break-after: page; overflow: hidden; }
  header { display: flex; justify-content: space-between; align-items: flex-end; gap: 8mm; border-bottom: 2.5pt solid #111; padding-bottom: 3mm; margin-bottom: 3mm; }
  h1 { font-size: 20pt; font-weight: 800; margin: 0; }
  header p { margin: 0; font-size: 10pt; color: #444; }
  .id { border-collapse: collapse; font-size: 10.5pt; }
  .id th, .id td { border: 1pt solid #111; height: 9mm; padding: 0 2.5mm; }
  .id th { background: #eee; font-weight: 600; white-space: nowrap; }
  .id td { width: 24mm; } .id td.w { width: 36mm; }
  .tips { border: 1pt solid #111; border-radius: 2mm; padding: 2.5mm 4mm; margin-bottom: 3mm; font-size: 10pt; }
  .tips b { font-weight: 800; }
  .tips ul { margin: 1mm 0 0; padding-left: 5mm; columns: 2; column-gap: 8mm; }
  .tips li { break-inside: avoid; }
  .q { flex: 1; display: flex; flex-direction: column; min-height: 0; margin-top: 3.5mm; }
  .q h2 { font-size: 12.5pt; font-weight: 800; margin: 0 0 1mm; display: flex; gap: 2.5mm; align-items: baseline; }
  .q h2 span { flex: none; background: #111; color: #fff; border-radius: 50%; width: 6.5mm; height: 6.5mm; display: inline-grid; place-items: center; font-size: 10.5pt; transform: translateY(-.3mm); }
  .guide { margin: 0 0 1.5mm; font-size: 9.5pt; color: #333; }
  .frames { margin: 0 0 1.5mm; padding: 1.5mm 3mm 1.5mm 7mm; background: #f1f1f1; border-radius: 1.5mm; font-size: 9pt; }
  .lines { flex: 1; border: 1pt solid #111; border-radius: 1.5mm;
    background-image: repeating-linear-gradient(to bottom, transparent 0, transparent calc(9mm - .5pt), #bbb calc(9mm - .5pt), #bbb 9mm); background-position: 0 -1pt; }
  footer { margin-top: 2.5mm; font-size: 9pt; color: #555; display: flex; justify-content: space-between; }
  .ex { margin-top: 5mm; break-inside: avoid; }
  .ex h2 { font-size: 13pt; font-weight: 800; margin: 0 0 1mm; }
  .ex p { margin: 0; padding: 3mm 4mm; border-left: 3pt solid #111; background: #f1f1f1; font-size: 12pt; line-height: 1.65; }
  .note { border: 1pt solid #111; border-radius: 2mm; padding: 2.5mm 4mm; font-size: 10pt; }
</style></head><body>
  <div class="page">
    ${head('SLAT 최종 보고서', '학교주도활동 주제 탐구 프로젝트 · 개인별 작성')}
    <div class="tips"><b>좋은 보고서는 이렇게 씁니다</b>
      <ul>
        <li><b>구체적으로</b> — ‘열심히 했다’ 대신 무엇을, 어떻게, 몇 번 했는지</li>
        <li><b>‘나’를 주어로</b> — 팀이 아니라 내가 맡은 역할과 내가 한 생각</li>
        <li><b>과정을 보여 주기</b> — 왜 그렇게 했는지, 막혔을 때 어떻게 했는지</li>
        <li>질문마다 <b>3~5문장</b>. 작성 예시는 쓰는 방식만 참고하고 베끼지 않기</li>
      </ul>
    </div>
    ${QS.slice(0, half).map((q, i) => question(q, i)).join('')}
    <footer><span>※ 뒷면에 이어서 작성합니다.</span><span>1 / 2</span></footer>
  </div>
  <div class="page">
    ${head('SLAT 최종 보고서', '뒷면 · 앞면과 같은 학번·이름을 적어 주세요')}
    ${QS.slice(half).map((q, i) => question(q, i + half)).join('')}
    <footer><span>※ 같은 내용을 SLAT 기록장 사이트의 [최종 보고서]에도 입력해 제출합니다.</span><span>2 / 2</span></footer>
  </div>
  <div class="page">
    <header><div><h1>작성 예시</h1><p>가상의 팀이 쓴 예시입니다 · 주제: 환기 방법에 따른 교실 이산화탄소 농도 변화</p></div></header>
    <div class="note">이 예시는 <b>여러분과 다른 주제</b>로 쓴 것입니다. 내용을 베끼지 말고, <b>얼마나 구체적으로 쓰는지 · ‘나’가 한 일이 드러나는지 · 문제→원인→해결→결과 순서로 쓰는지</b>를 보세요.</div>
    ${QS.map((q, i) => `<section class="ex"><h2>${i + 1}. ${esc(q.title)}</h2><p>${esc(q.example)}</p></section>`).join('')}
  </div>
</body></html>`;

(async () => {
  const out = path.join(__dirname, 'SLAT_최종보고서_B4.pdf');
  const tmp = path.join(__dirname, '.sheet.html');
  fs.writeFileSync(tmp, html);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(pathToFileURL(tmp).href);
  await page.evaluate(() => document.fonts.ready);
  await page.pdf({ path: out, width: '257mm', height: '364mm', printBackground: true });
  await browser.close();
  fs.unlinkSync(tmp);
  console.log(out);
})();
