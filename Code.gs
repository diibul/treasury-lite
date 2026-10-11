/**
 * KONFIGURASI
 * Jangan hardcode token di sini. Simpan lewat:
 * Apps Script editor > ikon gerigi "Project Settings" > Script Properties > Add script property
 *   - BOT_TOKEN            : token dari @BotFather
 *   - AUTHORIZED_USER_ID   : user ID Telegram kamu sendiri
 *   - WEBAPP_URL           : URL Web App hasil deploy (berakhiran /exec)
 *   - WEBHOOK_KEY          : kunci rahasia acak buatan sendiri, dipasang di URL webhook (?key=...)
 *                            supaya request palsu dari luar Telegram ditolak
 */
const SHEET_TRANSAKSI = 'Transaksi';

/**
 * Entry point — dipanggil otomatis tiap Telegram kirim update ke Web App URL ini.
 */
function doPost(e) {
  try {
    // Tolak request tanpa kunci yang benar (bukan dari webhook yang kita daftarkan).
    // Sengaja tanpa log supaya sheet Debug tidak bisa dibanjiri request iseng.
    const webhookKey = PropertiesService.getScriptProperties().getProperty('WEBHOOK_KEY');
    if (!webhookKey || !e.parameter || e.parameter.key !== webhookKey) {
      return respond_();
    }

    const update = JSON.parse(e.postData.contents);
    const message = update.message;
    if (!message || !message.text) {
      debugLog_('Tidak ada message/text di update ini, berhenti di sini.');
      return respond_();
    }

    const senderId = String(message.from.id);
    const authorizedId = PropertiesService.getScriptProperties().getProperty('AUTHORIZED_USER_ID');

    // Bukan kamu -> diamkan saja, jangan balas apa pun
    if (senderId !== authorizedId) {
      return respond_();
    }

    const chatId = message.chat.id;
    const text = message.text.trim();
    debugLog_('Routing command untuk text=[' + text + ']');
    routeCommand_(chatId, text);
    debugLog_('SUKSES: command selesai diproses.');

  } catch (err) {
    debugLog_('ERROR TERTANGKAP: ' + err.message);
  }
  return respond_();
}

/**
 * COMMAND ROUTER
 * Cara nambah command baru: tambah 1 objek {match, handler} ke array COMMANDS
 * di bawah, lalu bikin fungsi handler-nya sendiri (function handleXxx_(chatId, text) {...}).
 * TIDAK perlu ubah kode doPost atau routeCommand_ sama sekali.
 */
function routeCommand_(chatId, text) {
  const normalized = text.toLowerCase().trim().replace(/[?!.]+$/, '');

  for (let i = 0; i < COMMANDS.length; i++) {
    if (COMMANDS[i].match(normalized)) {
      COMMANDS[i].handler(chatId, text);
      return;
    }
  }

  sendMessage_(chatId, 'Perintah nggak dikenali. Contoh: lapor pengeluaran 15000 kopi');
}

const COMMANDS = [
  {
    match: function (t) { return t.startsWith('lapor '); },
    handler: handleLapor_
  },
  {
    match: function (t) { return t === 'ringkasan'; },
    handler: handleRingkasan_
  },
  {
    match: function (t) { return t === 'cek kondisi'; },
    handler: handleCekKondisi_
  },
  {
    match: function (t) { return t === 'aman sampai kapan'; },
    handler: handleAmanSampaiKapan_
  },
  {
    match: function (t) { return t === 'hapus transaksi terakhir' || t === 'batalkan'; },
    handler: handleHapusTerakhir_
  }
  // Command baru ditambah di sini nanti, contoh:
  // { match: function(t) { return t === 'contoh'; }, handler: handleContoh_ }
];

/**
 * HANDLER: lapor pemasukan/pengeluaran (nominal) (keterangan)
 */
function handleLapor_(chatId, text) {
  const result = parseLaporan_(text);

  if (!result.valid) {
    sendMessage_(chatId, result.error);
    return;
  }

  catatTransaksi_(result.tipe, result.nominal, result.keterangan);
  const nominalFormat = result.nominal.toLocaleString('id-ID');
  sendMessage_(chatId, `✅ Tercatat\nTipe: ${result.tipe}\nNominal: Rp${nominalFormat}\nKeterangan: ${result.keterangan}`);
}

/**
 * HANDLER: hapus transaksi terakhir / batalkan
 * Hapus baris paling bawah di Transaksi, tanpa konfirmasi 2 langkah (biar simpel —
 * ini bot pribadi, kalau ternyata salah hapus tinggal "lapor" ulang).
 */
function handleHapusTerakhir_(chatId, text) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_TRANSAKSI);
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    sendMessage_(chatId, 'Belum ada transaksi yang bisa dihapus.');
    return;
  }

  const rowData = sheet.getRange(lastRow, 1, 1, 4).getValues()[0]; // Tanggal, Tipe, Nominal, Keterangan
  const tipe = rowData[1];
  const nominal = rowData[2];
  const keterangan = rowData[3];

  sheet.deleteRow(lastRow);

  const nominalFormat = Number(nominal).toLocaleString('id-ID');
  sendMessage_(chatId, `🗑️ Dihapus\nTipe: ${tipe}\nNominal: Rp${nominalFormat}\nKeterangan: ${keterangan}`);
}

/**
 * HANDLER: ringkasan
 * Balas Pemasukan/Pengeluaran/Saldo bulan berjalan (dihitung langsung dari sheet Transaksi,
 * nggak numpang Dashboard — biar bot tetap jalan meski Dashboard-nya lagi diubah-ubah).
 */
function handleRingkasan_(chatId, text) {
  const today = new Date();
  const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);

  const pemasukan = sumTransaksiPeriode_('pemasukan', startOfMonth, endOfMonth);
  const pengeluaran = sumTransaksiPeriode_('pengeluaran', startOfMonth, endOfMonth);
  const saldo = pemasukan - pengeluaran;
  const namaBulan = Utilities.formatDate(today, Session.getScriptTimeZone(), 'MMMM yyyy');

  const pesan = `📊 Ringkasan ${namaBulan}\n\n`
    + `Pemasukan: Rp${pemasukan.toLocaleString('id-ID')}\n`
    + `Pengeluaran: Rp${pengeluaran.toLocaleString('id-ID')}\n`
    + `Saldo: Rp${saldo.toLocaleString('id-ID')}`;

  sendMessage_(chatId, pesan);
}

/**
 * Helper: jumlahkan Nominal dari Transaksi untuk Tipe tertentu, dalam rentang tanggal tertentu.
 * Dipakai bareng-bareng oleh handleRingkasan_ dan command-command laporan lain nanti.
 */
function sumTransaksiPeriode_(tipe, startDate, endDate) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_TRANSAKSI);
  const data = sheet.getDataRange().getValues();
  let total = 0;

  for (let i = 1; i < data.length; i++) { // baris 0 = header, dilewati
    const tanggal = data[i][0];
    const tipeRow = data[i][1];
    const nominal = data[i][2];

    if (tipeRow === tipe && tanggal instanceof Date && tanggal >= startDate && tanggal < endDate) {
      if (typeof nominal === 'number') {
        total += nominal;
      } else {
        // Nominal bukan angka (misal sel kekonversi jadi format tanggal) — jangan dijumlahin,
        // soalnya bikin hasil jadi teks acak. Dicatat ke Debug biar ketauan baris mana yang rusak.
        debugLog_('PERINGATAN: Nominal baris ' + (i + 1) + ' bukan angka (' + nominal + '), dilewati dari penjumlahan.');
      }
    }
  }

  return total;
}

/**
 * HANDLER: cek kondisi
 * Snapshot lengkap kondisi keuangan bulan berjalan: Pemasukan, Pengeluaran, Savings Ratio,
 * Budget Usage (total pengeluaran vs total budget SEMUA kategori dari sheet Kategori),
 * Status kualitatif, dan forecast estimasi pengeluaran akhir bulan berdasarkan rata-rata
 * harian sejauh ini.
 *
 * Catatan: ambang batas Status (70% / 100%) itu pilihanku, gampang diubah di bawah kalau
 * kamu mau lebih longgar/ketat.
 */
function handleCekKondisi_(chatId, text) {
  const today = new Date();
  const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);

  const pemasukan = sumTransaksiPeriode_('pemasukan', startOfMonth, endOfMonth);
  const pengeluaran = sumTransaksiPeriode_('pengeluaran', startOfMonth, endOfMonth);
  const saldo = pemasukan - pengeluaran;
  const savingsRatio = pemasukan > 0 ? (saldo / pemasukan) * 100 : 0;

  const totalBudget = sumTotalBudgetSemuaKategori_();
  const budgetUsage = totalBudget > 0 ? (pengeluaran / totalBudget) * 100 : 0;

  let status;
  if (budgetUsage < 70) {
    status = 'SEHAT ✅';
  } else if (budgetUsage < 100) {
    status = 'WASPADA ⚠️';
  } else {
    status = 'OVERBUDGET 🔴';
  }

  const hariBerjalan = today.getDate();
  const rataRataHarian = hariBerjalan > 0 ? pengeluaran / hariBerjalan : 0;
  const totalHariBulan = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const forecast = Math.round(rataRataHarian * totalHariBulan);

  const namaBulan = Utilities.formatDate(today, Session.getScriptTimeZone(), 'MMMM yyyy');

  const pesan = `📋 Cek Kondisi\nPeriode: ${namaBulan}\n\n`
    + `Pemasukan: Rp${pemasukan.toLocaleString('id-ID')}\n`
    + `Pengeluaran: Rp${pengeluaran.toLocaleString('id-ID')}\n`
    + `Savings Ratio: ${savingsRatio.toFixed(0)}%\n`
    + `Budget Usage: ${budgetUsage.toFixed(0)}%\n`
    + `Status: ${status}\n\n`
    + `📈 Kalau pola pengeluaran tetap sama, estimasi akhir bulan ≈ Rp${forecast.toLocaleString('id-ID')}`;

  sendMessage_(chatId, pesan);
}

/**
 * Helper: total Target Budget dari SEMUA kategori pengeluaran (Tetap + Variabel), kolom D di sheet Kategori.
 */
function sumTotalBudgetSemuaKategori_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Kategori');
  const data = sheet.getDataRange().getValues();
  let total = 0;

  for (let i = 1; i < data.length; i++) { // baris 0 = header
    const budget = data[i][3]; // kolom D (index 3)
    if (typeof budget === 'number') {
      total += budget;
    }
  }

  return total;
}

/**
 * HANDLER: aman sampai kapan
 * Estimasi berapa hari saldo saat ini bakal bertahan, berdasarkan rata-rata
 * pengeluaran harian bulan berjalan.
 */
function handleAmanSampaiKapan_(chatId, text) {
  const today = new Date();
  const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);

  const pemasukan = sumTransaksiPeriode_('pemasukan', startOfMonth, endOfMonth);
  const pengeluaran = sumTransaksiPeriode_('pengeluaran', startOfMonth, endOfMonth);
  const saldo = pemasukan - pengeluaran;

  const hariBerjalan = today.getDate();
  const rataRataHarian = hariBerjalan > 0 ? pengeluaran / hariBerjalan : 0;

  let pesan;
  if (rataRataHarian <= 0) {
    pesan = `💰 Saldo saat ini: Rp${saldo.toLocaleString('id-ID')}\n\n`
      + `Belum cukup data pengeluaran bulan ini buat ngitung rata-rata harian.`;
  } else {
    const estimasiHari = Math.floor(saldo / rataRataHarian);
    pesan = `💰 Saldo saat ini: Rp${saldo.toLocaleString('id-ID')}\n`
      + `📉 Rata-rata pengeluaran: Rp${Math.round(rataRataHarian).toLocaleString('id-ID')}/hari\n`
      + `⏳ Estimasi bertahan: ±${estimasiHari} hari`;
  }

  sendMessage_(chatId, pesan);
}

/**
 * Tulis 1 baris debug ke sheet "Debug" (auto-dibuat kalau belum ada).
 * Sementara aja buat cari bug — nanti kalau semua udah lancar, boleh dihapus.
 */
function debugLog_(msg) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('Debug');
  if (!sheet) {
    sheet = ss.insertSheet('Debug');
  }
  sheet.appendRow([new Date(), msg]);
}

/**
 * Parsing format: lapor pemasukan|pengeluaran (nominal) (keterangan...)
 */
function parseLaporan_(text) {
  const parts = text.split(/\s+/);
  const contoh = 'Contoh: lapor pengeluaran 15000 kopi';

  if (parts.length < 4 || parts[0].toLowerCase() !== 'lapor') {
    return { valid: false, error: `Format salah. ${contoh}` };
  }

  const tipe = parts[1].toLowerCase();
  if (tipe !== 'pemasukan' && tipe !== 'pengeluaran') {
    return { valid: false, error: `Tipe harus "pemasukan" atau "pengeluaran". ${contoh}` };
  }

  // Buang titik/koma dulu (orang Indonesia biasa nulis pemisah ribuan, misal "24.000" atau "24,000"),
  // soalnya Number() JavaScript baca titik sebagai tanda DESIMAL, bukan pemisah ribuan — kalau nggak
  // dibuang, "24.000" kebaca 24 doang, bukan 24000.
  const nominalBersih = parts[2].replace(/[.,]/g, '');
  const nominal = Number(nominalBersih);
  if (isNaN(nominal) || nominal <= 0) {
    return { valid: false, error: `Nominal harus berupa angka. ${contoh}` };
  }

  const keterangan = parts.slice(3).join(' ');
  if (!keterangan) {
    return { valid: false, error: `Keterangan tidak boleh kosong. ${contoh}` };
  }

  return { valid: true, tipe, nominal, keterangan };
}

/**
 * Tulis baris baru ke sheet Transaksi.
 * Kolom Kategori sengaja dikosongkan dulu — diisi manual lewat dropdown di Sheets.
 * Dropdown-nya langsung di-set DI SINI (bukan nunggu trigger onEdit), karena trigger
 * onEdit terbukti TIDAK jalan untuk baris yang ditulis via script (appendRow) —
 * onEdit cuma reliable buat perubahan manual user lewat UI Sheets.
 */
function catatTransaksi_(tipe, nominal, keterangan) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_TRANSAKSI);
  sheet.appendRow([new Date(), tipe, nominal, keterangan]);
  const row = sheet.getLastRow(); // baris yang baru aja ditulis
  updateDropdownSatuBaris_(sheet, row, false); // false: kategori masih kosong, nggak perlu di-clear
}

/**
 * Kirim balasan ke chat Telegram.
 */
function sendMessage_(chatId, text) {
  const token = PropertiesService.getScriptProperties().getProperty('BOT_TOKEN');
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ chat_id: chatId, text: text }),
    muteHttpExceptions: true
  });
}

function respond_() {
  // Sengaja pakai HtmlService, bukan ContentService — ContentService selalu
  // dibalas lewat redirect 302 yang TIDAK diikuti oleh Telegram, bikin webhook dianggap gagal.
  return HtmlService.createHtmlOutput('ok');
}

/**
 * SETUP SEKALI JALAN
 * Setelah deploy Web App, isi WEB_APP_URL di bawah dengan URL hasil deploy,
 * lalu jalankan fungsi ini SEKALI dari menu Run di Apps Script editor.
 */
function setWebhookOnce() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('BOT_TOKEN');
  const webAppUrl = props.getProperty('WEBAPP_URL');
  const webhookKey = props.getProperty('WEBHOOK_KEY');
  if (!token || !webAppUrl || !webhookKey) {
    throw new Error('BOT_TOKEN, WEBAPP_URL, dan WEBHOOK_KEY harus diisi dulu di Script Properties.');
  }
  const fullUrl = webAppUrl + '?key=' + encodeURIComponent(webhookKey);
  const url = `https://api.telegram.org/bot${token}/setWebhook?url=${encodeURIComponent(fullUrl)}`;
  const response = UrlFetchApp.fetch(url);
  Logger.log(response.getContentText());
}

/**
 * BACKUP OTOMATIS
 * Bikin salinan spreadsheet ini ke folder khusus di Drive, dengan nama bertanggal.
 * Dipanggil otomatis lewat time-driven trigger (setup manual sekali di halaman Pemicu).
 * Otomatis buang salinan lama kalau udah lebih dari MAX_BACKUPS, biar Drive nggak numpuk.
 */
const MAX_BACKUPS = 6; // simpan 6 backup terakhir saja (kalau bulanan = kira-kira 6 bulan terakhir)
const BACKUP_FOLDER_NAME = 'Backup Pembukuan Pribadi';

function backupSpreadsheet() {
  const sourceFile = DriveApp.getFileById(SpreadsheetApp.getActiveSpreadsheet().getId());
  const folder = getOrCreateBackupFolder_();
  const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const backupName = 'Backup Pembukuan Pribadi - ' + timestamp;

  sourceFile.makeCopy(backupName, folder);
  cleanupOldBackups_(folder);
}

function getOrCreateBackupFolder_() {
  const existing = DriveApp.getFoldersByName(BACKUP_FOLDER_NAME);
  if (existing.hasNext()) {
    return existing.next();
  }
  return DriveApp.createFolder(BACKUP_FOLDER_NAME);
}

function cleanupOldBackups_(folder) {
  const files = folder.getFiles();
  const fileList = [];
  while (files.hasNext()) {
    fileList.push(files.next());
  }
  fileList.sort((a, b) => a.getDateCreated() - b.getDateCreated());

  while (fileList.length > MAX_BACKUPS) {
    const oldest = fileList.shift();
    oldest.setTrashed(true);
  }
}

/**
 * REMINDER HARIAN
 * Kirim pesan pengingat ke chat sendiri. Dipanggil otomatis lewat time-driven trigger
 * (setup manual di halaman Pemicu, mis. tiap hari jam 20:00).
 */
function kirimReminderHarian() {
  const chatId = PropertiesService.getScriptProperties().getProperty('AUTHORIZED_USER_ID');

  // Tambah/edit/hapus kalimat di daftar ini sesukamu — tiap baris satu variasi pesan.
  const daftarPesan = [
    '📝 Udah catat pemasukan/pengeluaran hari ini belum?',
    '💰 Jangan lupa lapor transaksi hari ini ya!',
    '🧾 Cek dompet, ada yang belum kecatet nggak?',
    '📊 Waktunya review pengeluaran hari ini!',
    '✅ Ojo lali nyatet Bos!'
  ];

  const pesanTerpilih = daftarPesan[Math.floor(Math.random() * daftarPesan.length)];
  sendMessage_(chatId, pesanTerpilih);
}

/**
 * DROPDOWN KATEGORI DINAMIS
 * Setiap kali kolom Tipe (B) di sheet Transaksi diedit, otomatis ganti aturan
 * dropdown kolom Kategori (E) di baris yang sama — cuma nongolin kategori
 * pengeluaran kalau Tipe=pengeluaran, atau kategori pemasukan kalau Tipe=pemasukan.
 * Dipasang sebagai installable trigger "On edit" (setup manual di halaman Pemicu).
 */
function updateKategoriDropdown(e) {
  const range = e.range;
  const sheet = range.getSheet();

  if (sheet.getName() !== 'Transaksi') return;

  // Kolom B (Tipe) harus ADA DI DALAM rentang yang diedit — bukan cuma sama persis.
  // Ini penting karena bot nulis 4 kolom sekaligus (A:D) lewat appendRow, bukan cuma kolom B sendirian.
  const startCol = range.getColumn();
  const endCol = startCol + range.getNumColumns() - 1;
  if (startCol > 2 || endCol < 2) return;

  const startRow = range.getRow();
  const numRows = range.getNumRows();

  for (let i = 0; i < numRows; i++) {
    const row = startRow + i;
    if (row === 1) continue; // skip header
    updateDropdownSatuBaris_(sheet, row, true); // true = boleh clear isi kategori kalau nggak cocok lagi
  }
}

/**
 * Set/reset aturan dropdown Kategori untuk 1 baris tertentu, berdasarkan isi Tipe di baris itu.
 * Dipakai bareng-bareng oleh updateKategoriDropdown (trigger) dan initKategoriDropdownSemuaBaris (setup manual).
 *
 * clearJugaIsinya: kalau true, kosongkan isi Kategori setelah ganti aturan (dipakai pas trigger live —
 * baris baru dari bot memang masih kosong jadi aman, baris yang Tipe-nya baru diubah manual juga perlu
 * dikosongkan biar nggak nyisa kategori dari Tipe lama yang udah nggak cocok).
 * Kalau false/tidak diisi, isi Kategori yang sudah ada TIDAK disentuh — dipakai pas initKategoriDropdownSemuaBaris,
 * biar backfill nggak ngehapus kategori yang udah bener dipilih sebelumnya.
 */
function updateDropdownSatuBaris_(sheet, row, clearJugaIsinya) {
  const tipe = sheet.getRange(row, 2).getValue();
  const kategoriCell = sheet.getRange(row, 5); // kolom E (Kategori)
  const kategoriSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Kategori');

  let sourceRange;
  if (tipe === 'pengeluaran') {
    const lastRow = getLastRowInColumn_(kategoriSheet, 1); // kolom A
    sourceRange = kategoriSheet.getRange(2, 1, lastRow - 1, 1); // A2 sampai baris terakhir yang keisi
  } else if (tipe === 'pemasukan') {
    const lastRow = getLastRowInColumn_(kategoriSheet, 2); // kolom B
    sourceRange = kategoriSheet.getRange(2, 2, lastRow - 1, 1); // B2 sampai baris terakhir yang keisi
  } else {
    return; // Tipe kosong/nggak dikenali, jangan diapa-apain
  }

  const rule = SpreadsheetApp.newDataValidation().requireValueInRange(sourceRange, true).setAllowInvalid(false).build();
  kategoriCell.setDataValidation(rule);
  if (clearJugaIsinya) {
    kategoriCell.clearContent();
  }
}

/**
 * Cari baris terakhir yang keisi di 1 kolom tertentu (dihitung independen dari kolom lain).
 * Dipakai biar dropdown Kategori otomatis nyesuain kalau kamu nambah/kurangin kategori
 * di sheet Kategori — nggak perlu update kode lagi selamanya.
 * col: nomor kolom (1 = A, 2 = B, dst)
 */
function getLastRowInColumn_(sheet, col) {
  const values = sheet.getRange(1, col, sheet.getMaxRows(), 1).getValues();
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i][0] !== '') {
      return i + 1; // +1 karena array 0-indexed, baris sheet 1-indexed
    }
  }
  return 1; // cuma header doang, belum ada data
}

/**
 * SETUP SEKALI JALAN
 * Perbaiki dropdown kategori untuk baris-baris yang SUDAH ADA (bukan baris baru).
 * Jalankan manual sekali dari menu Run. TIDAK menghapus kategori yang sudah dipilih.
 */
function initKategoriDropdownSemuaBaris() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Transaksi');
  const lastRow = sheet.getLastRow();

  for (let row = 2; row <= lastRow; row++) {
    updateDropdownSatuBaris_(sheet, row, false); // false = isi kategori yang sudah ada TIDAK dihapus
  }
}

/**
 * AUTO UPDATE PERIODE DASHBOARD
 * Otomatis ganti Bulan & Tahun di Dashboard (B3, B4) ke bulan berjalan.
 * Dijalankan sekali di awal tiap bulan lewat time-driven trigger (setup manual di halaman Pemicu,
 * mis. tanggal 1 jam 00:01-01:00). Kamu tetap bisa geser manual ke bulan lain kapan pun buat lihat
 * histori — ini cuma nge-reset ke "bulan sekarang" pas pergantian bulan biar nggak kelupaan.
 *
 * Nama bulan di-map manual pakai daftar sendiri (bukan Utilities.formatDate) biar PASTI selalu
 * bahasa Inggris apa pun locale spreadsheet-nya — harus persis cocok sama isi Z1:Z12.
 */
const NAMA_BULAN_INGGRIS_ = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function autoUpdatePeriodeDashboard() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Dashboard');
  const today = new Date();
  const namaBulan = NAMA_BULAN_INGGRIS_[today.getMonth()];
  const tahun = today.getFullYear();

  sheet.getRange('B3').setValue(namaBulan);
  sheet.getRange('B4').setValue(tahun);
}

/**
 * WEEKLY FINANCIAL SUMMARY
 * Kirim laporan proaktif tiap Minggu malam (setup trigger: Week timer, Sunday).
 * Periode: 7 hari ke belakang termasuk hari ini.
 */
function kirimRingkasanMingguan() {
  const chatId = PropertiesService.getScriptProperties().getProperty('AUTHORIZED_USER_ID');
  const today = new Date();
  const startOfWeek = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6);
  const endOfWeek = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);

  const pemasukan = sumTransaksiPeriode_('pemasukan', startOfWeek, endOfWeek);
  const pengeluaran = sumTransaksiPeriode_('pengeluaran', startOfWeek, endOfWeek);
  const saldoBertambah = pemasukan - pengeluaran;

  const breakdown = breakdownKategoriPengeluaranPeriode_(startOfWeek, endOfWeek);
  let kategoriTerbesar = null;
  let totalTerbesar = 0;
  for (const kategori in breakdown) {
    if (breakdown[kategori] > totalTerbesar) {
      totalTerbesar = breakdown[kategori];
      kategoriTerbesar = kategori;
    }
  }

  let pesan = `📊 Weekly Financial Summary\n\n`
    + `Pemasukan: Rp${pemasukan.toLocaleString('id-ID')}\n`
    + `Pengeluaran: Rp${pengeluaran.toLocaleString('id-ID')}\n`
    + `Saldo bertambah: Rp${saldoBertambah.toLocaleString('id-ID')}\n`;

  if (kategoriTerbesar) {
    pesan += `Kategori paling boros: ${kategoriTerbesar}\nNominal: Rp${totalTerbesar.toLocaleString('id-ID')}`;
  } else {
    pesan += `Belum ada pengeluaran minggu ini.`;
  }

  sendMessage_(chatId, pesan);
}

/**
 * Helper: breakdown total pengeluaran per kategori dalam rentang tanggal tertentu.
 * Dipakai bareng-bareng oleh kirimRingkasanMingguan dan (nanti) Monthly Closing.
 * Return: object { "NamaKategori": totalNominal, ... }
 */
function breakdownKategoriPengeluaranPeriode_(awal, akhir) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_TRANSAKSI);
  const data = sheet.getDataRange().getValues();
  const hasil = {};

  for (let i = 1; i < data.length; i++) {
    const tanggal = data[i][0];
    const tipe = data[i][1];
    const nominal = data[i][2];
    const kategori = data[i][4]; // kolom E

    if (tipe === 'pengeluaran' && tanggal >= awal && tanggal < akhir && kategori) {
      if (typeof nominal === 'number') {
        hasil[kategori] = (hasil[kategori] || 0) + nominal;
      } else {
        debugLog_('PERINGATAN: Nominal baris ' + (i + 1) + ' bukan angka (' + nominal + '), dilewati dari breakdown kategori.');
      }
    }
  }

  return hasil;
}

/**
 * MONTHLY CLOSING
 * Snapshot bulan yang baru saja berakhir ke sheet "Histori Bulanan" — jadi histori
 * keuangan aman dan tidak bergantung sama kondisi Dashboard saat ini (yang selalu
 * nunjukin bulan berjalan). Dijalankan otomatis di awal tiap bulan lewat time-driven
 * trigger, terpisah dari trigger autoUpdatePeriodeDashboard (keduanya independen,
 * nggak saling bergantung urutannya).
 */
const SHEET_HISTORI = 'Histori Bulanan';

function tutupBulanLalu() {
  const now = new Date();
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const pemasukan = sumTransaksiPeriode_('pemasukan', startOfLastMonth, startOfThisMonth);
  const pengeluaran = sumTransaksiPeriode_('pengeluaran', startOfLastMonth, startOfThisMonth);
  const saldo = pemasukan - pengeluaran;
  const savingsRatio = pemasukan > 0 ? Math.round((saldo / pemasukan) * 100) : 0;

  const breakdown = breakdownKategoriPengeluaranPeriode_(startOfLastMonth, startOfThisMonth);
  let kategoriTerbesar = '-';
  let totalTerbesar = 0;
  for (const kategori in breakdown) {
    if (breakdown[kategori] > totalTerbesar) {
      totalTerbesar = breakdown[kategori];
      kategoriTerbesar = kategori;
    }
  }

  const totalBudget = sumTotalBudgetSemuaKategori_();
  const budgetUsage = totalBudget > 0 ? Math.round((pengeluaran / totalBudget) * 100) : 0;

  const namaBulan = NAMA_BULAN_INGGRIS_[startOfLastMonth.getMonth()];
  const tahun = startOfLastMonth.getFullYear();

  const historiSheet = getOrCreateHistoriSheet_();
  historiSheet.appendRow([namaBulan, tahun, pemasukan, pengeluaran, saldo, savingsRatio + '%', kategoriTerbesar, budgetUsage + '%']);

  const chatId = PropertiesService.getScriptProperties().getProperty('AUTHORIZED_USER_ID');
  const pesan = `📁 ${namaBulan} ${tahun} sudah ditutup.\n\n`
    + `Pemasukan: Rp${pemasukan.toLocaleString('id-ID')}\n`
    + `Pengeluaran: Rp${pengeluaran.toLocaleString('id-ID')}\n`
    + `Saldo: Rp${saldo.toLocaleString('id-ID')}\n`
    + `Savings Ratio: ${savingsRatio}%\n`
    + `Kategori terbesar: ${kategoriTerbesar}\n`
    + `Budget Usage: ${budgetUsage}%`;
  sendMessage_(chatId, pesan);
}

function getOrCreateHistoriSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_HISTORI);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_HISTORI);
    sheet.appendRow(['Bulan', 'Tahun', 'Pemasukan', 'Pengeluaran', 'Saldo', 'Savings Ratio', 'Kategori Terbesar', 'Budget Usage']);
  }
  return sheet;
}