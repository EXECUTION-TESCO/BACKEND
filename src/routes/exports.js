import { Router } from 'express';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { requireAuth } from '../auth.js';
import { findReports } from './reports.js';
import { ah } from '../utils.js';
import { todayStr } from '../utils.js';

const r = Router();
r.use(requireAuth);

const fmt = (d) => (d ? d.split('-').reverse().join('-') : '');

const COLS = [
  { key: 'reportDate', header: 'Date', width: 12, get: (x) => fmt(x.reportDate) },
  { key: 'engineerName', header: 'Engineer', width: 16 },
  { key: 'projectName', header: 'Site / Project', width: 22 },
  { key: 'todayProgress', header: "Today's Work Progress", width: 40 },
  { key: 'workCompleted', header: 'Work Completed Today', width: 36 },
  { key: 'tomorrowPlan', header: "Tomorrow's Plan", width: 32 },
  { key: 'materialRequired', header: 'Material Required', width: 22, get: (x) => x.materialRequired || '-' },
  { key: 'materialStatus', header: 'Material Status', width: 14 },
  { key: 'issues', header: 'Issues / Challenges', width: 28 },
  { key: 'remarks', header: 'Remarks', width: 24 },
  { key: 'progressPercent', header: 'Progress %', width: 10, get: (x) => (x.progressPercent ?? '') },
  { key: 'projectStatus', header: 'Status', width: 16 },
  { key: 'photos', header: 'Photos', width: 8, get: (x) => x.photos.length },
];
const val = (c, x) => (c.get ? c.get(x) : x[c.key] ?? '');

r.get('/reports', ah(async (req, res) => {
  const list = (await findReports(req.user, req.query)).map((x) => x.toJSON());
  const name = `daily-reports-${req.query.date || req.query.from || todayStr()}`;

  if (req.query.format === 'pdf') {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.pdf"`);
    doc.pipe(res);
    doc.fontSize(16).fillColor('#0f2a4a').text('Daily Site Reports', { continued: false });
    const range = req.query.date ? fmt(req.query.date) : [req.query.from && `From ${fmt(req.query.from)}`, req.query.to && `To ${fmt(req.query.to)}`].filter(Boolean).join('  ') || 'All dates';
    doc.fontSize(9).fillColor('#555').text(`${range}   •   ${list.length} report(s)   •   Generated ${fmt(todayStr())}`);
    doc.moveDown(0.6);

    const cols = [
      { h: 'Date', w: 58, v: (x) => fmt(x.reportDate) },
      { h: 'Engineer', w: 70, v: (x) => x.engineerName },
      { h: 'Site', w: 85, v: (x) => x.projectName },
      { h: "Today's Work", w: 170, v: (x) => [x.todayProgress, x.workCompleted && `Done: ${x.workCompleted}`].filter(Boolean).join('\n') },
      { h: "Tomorrow's Plan", w: 120, v: (x) => x.tomorrowPlan },
      { h: 'Material', w: 95, v: (x) => (x.materialRequired ? `${x.materialRequired} (${x.materialStatus})` : '-') },
      { h: 'Issues / Remarks', w: 115, v: (x) => [x.issues, x.remarks].filter(Boolean).join('\n') },
      { h: 'Status', w: 72, v: (x) => `${x.projectStatus}${x.progressPercent != null ? `\n${x.progressPercent}%` : ''}` },
    ];
    const left = doc.page.margins.left;
    const pad = 3;
    const drawHeader = () => {
      let xx = left;
      const y = doc.y;
      doc.rect(left, y, cols.reduce((s, c) => s + c.w, 0), 16).fill('#0f2a4a');
      doc.fillColor('#fff').fontSize(8).font('Helvetica-Bold');
      cols.forEach((c) => { doc.text(c.h, xx + pad, y + 4, { width: c.w - pad * 2 }); xx += c.w; });
      doc.font('Helvetica').fillColor('#222');
      doc.y = y + 16;
    };
    drawHeader();
    list.forEach((x, i) => {
      doc.fontSize(7.5);
      const texts = cols.map((c) => String(c.v(x) ?? ''));
      const hgt = Math.max(...texts.map((t, k) => doc.heightOfString(t || ' ', { width: cols[k].w - pad * 2 }))) + pad * 2;
      if (doc.y + hgt > doc.page.height - doc.page.margins.bottom) { doc.addPage(); drawHeader(); doc.fontSize(7.5); }
      const y = doc.y;
      if (i % 2 === 0) doc.rect(left, y, cols.reduce((s, c) => s + c.w, 0), hgt).fill('#f2f5f9');
      doc.fillColor('#222');
      let xx = left;
      texts.forEach((t, k) => { doc.text(t, xx + pad, y + pad, { width: cols[k].w - pad * 2 }); xx += cols[k].w; });
      doc.y = y + hgt;
    });
    if (!list.length) doc.fontSize(10).text('No reports for the selected filters.');
    doc.end();
    return;
  }

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Daily Reports');
  ws.columns = COLS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  list.forEach((x) => ws.addRow(Object.fromEntries(COLS.map((c) => [c.key, val(c, x)]))));
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F2A4A' } };
  ws.eachRow((row) => row.eachCell((cell) => { cell.alignment = { vertical: 'top', wrapText: true }; }));
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: 'A1', to: `${String.fromCharCode(64 + COLS.length)}1` };
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}));

export default r;
