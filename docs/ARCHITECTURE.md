# Arsitektur

Dokumen ini menjelaskan bagaimana bot pembukuan bekerja, dari pesan Telegram sampai baris di Google Sheets.

## Gambaran umum

```
Telegram App
    |  (pesan)
    v
Telegram Bot API
    |  (webhook POST ke URL Web App + ?key=...)
    v
Apps Script Web App: doPost(e)
    |-- validasi kunci webhook
    |-- validasi ID pengirim
    v
routeCommand_()  -->  handler command
    |
    v
Google Sheets (Transaksi, Kategori, Dashboard, Histori Bulanan, Debug)
    |
    v
sendMessage_()  -->  Telegram Bot API  -->  balasan ke chat
```

Semua kode berada dalam satu file, `Code.gs`, dan berjalan di Google Apps Script. Tidak ada server, database, atau dependensi eksternal.

## Alur pesan masuk

1. Telegram mengirim update ke URL Web App lewat webhook.
2. `doPost` memeriksa parameter `key` terhadap `WEBHOOK_KEY` di Script Properties. Kalau tidak cocok, request diabaikan tanpa log, supaya sheet `Debug` tidak bisa dibanjiri request iseng.
3. `doPost` mengambil teks pesan dan memeriksa ID pengirim terhadap `AUTHORIZED_USER_ID`. Pengirim lain diabaikan tanpa balasan.
4. `routeCommand_` menormalkan teks (huruf kecil, tanda baca akhir dibuang), lalu mencari command pertama yang cocok.
5. Handler menjalankan logikanya, lalu membalas lewat `sendMessage_`.
6. `doPost` selalu mengembalikan `HtmlService.createHtmlOutput('ok')` agar Telegram menganggap webhook berhasil.

## Command router

Command didaftarkan di array `COMMANDS`. Setiap entri berupa objek `{match, handler}`:

```javascript
{
  match: function (t) { return t === 'ringkasan'; },
  handler: handleRingkasan_
}
```

Menambah command berarti menambah satu objek dan satu fungsi handler. `doPost` dan `routeCommand_` tidak perlu diubah.

| Command | Fungsi |
|---|---|
| `lapor pemasukan/pengeluaran (nominal) (keterangan)` | Menambah baris ke `Transaksi` |
| `ringkasan` | Pemasukan, pengeluaran, dan saldo bulan berjalan |
| `cek kondisi` | Savings ratio, budget usage, status, dan forecast akhir bulan |
| `aman sampai kapan` | Estimasi berapa hari saldo bertahan |
| `hapus transaksi terakhir` / `batalkan` | Menghapus baris terakhir di `Transaksi` |

Command laporan menghitung langsung dari sheet `Transaksi` untuk bulan berjalan. Ini sengaja tidak bergantung pada Dashboard, sehingga bot tetap berjalan meskipun Dashboard sedang diubah.

## Model data

**`Transaksi`**: Tanggal, Tipe, Nominal, Keterangan, Kategori. Bot menulis empat kolom pertama, sedangkan Kategori dipilih lewat dropdown.

**`Kategori`**: daftar kategori pengeluaran, daftar kategori pemasukan, Target Budget, dan Jenis (Tetap atau Variabel). Dipakai untuk dropdown, Safe Daily Budget, dan Budget vs Actual.

**`Dashboard`**: tampilan ringkasan yang terhubung ke data `Transaksi` dan `Kategori`. Periode dipilih lewat sel Bulan dan Tahun, dan digeser otomatis oleh script tiap awal bulan.

**`Histori Bulanan`**: snapshot tiap bulan (pemasukan, pengeluaran, saldo, savings ratio, kategori terbesar, budget usage). Dibuat otomatis oleh script.

**`Debug`**: log teknis untuk troubleshooting. Dibuat otomatis dan tidak memuat data pribadi.

## Dropdown kategori dinamis

Pilihan di kolom Kategori bergantung pada kolom Tipe: kategori pengeluaran untuk `pengeluaran`, kategori pemasukan untuk `pemasukan`. Rentang sumbernya dihitung dari baris terakhir yang terisi (`getLastRowInColumn_`), jadi menambah kategori di sheet `Kategori` tidak memerlukan perubahan kode.

Aturan dropdown dipasang lewat dua jalur:

- **Dari bot:** `catatTransaksi_` memanggil `updateDropdownSatuBaris_` langsung setelah `appendRow`.
- **Dari edit manual:** trigger On edit `updateKategoriDropdown` memperbarui baris yang Tipe-nya diubah.

Dua jalur diperlukan karena trigger On edit tidak aktif untuk baris yang ditulis oleh script. Untuk memperbaiki baris yang sudah ada, tersedia fungsi sekali jalan `initKategoriDropdownSemuaBaris`, yang tidak menghapus kategori yang sudah terpilih.

## Perhitungan

- **Savings ratio** = (pemasukan - pengeluaran) / pemasukan.
- **Budget usage** = total pengeluaran / total Target Budget semua kategori.
- **Status:** SEHAT jika budget usage di bawah 70%, WASPADA di bawah 100%, OVERBUDGET jika 100% atau lebih.
- **Forecast akhir bulan** = rata-rata pengeluaran harian sejauh ini dikali jumlah hari dalam bulan.
- **Aman sampai kapan** = saldo dibagi rata-rata pengeluaran harian.

`sumTransaksiPeriode_` hanya menjumlahkan sel Nominal bertipe angka. Sel yang terbaca sebagai tanggal atau teks dilewati dan dicatat ke `Debug`, supaya satu baris rusak tidak merusak total.

## Otomatisasi (trigger)

| Fungsi | Jadwal | Tujuan |
|---|---|---|
| `kirimReminderHarian` | Harian | Pengingat acak untuk mencatat transaksi |
| `kirimRingkasanMingguan` | Mingguan (Minggu malam) | Weekly Financial Summary ke Telegram |
| `autoUpdatePeriodeDashboard` | Bulanan (tanggal 1) | Menggeser Bulan dan Tahun Dashboard ke periode berjalan |
| `tutupBulanLalu` | Bulanan (tanggal 1) | Snapshot bulan lalu ke `Histori Bulanan` dan kirim konfirmasi |
| `backupSpreadsheet` | Bulanan | Salinan ke folder Drive, menyimpan 6 terakhir |
| `updateKategoriDropdown` | On edit | Menjaga dropdown Kategori sesuai Tipe |

`autoUpdatePeriodeDashboard` dan `tutupBulanLalu` sama-sama berjalan di awal bulan tetapi tidak saling bergantung urutannya. Nama bulan dipetakan dari daftar sendiri (bukan `Utilities.formatDate`) agar selalu berbahasa Inggris, sesuai isi daftar bulan di Dashboard, apa pun locale spreadsheet.

## Keamanan

- **Rahasia di Script Properties:** `BOT_TOKEN`, `AUTHORIZED_USER_ID`, `WEBAPP_URL`, `WEBHOOK_KEY`. Tidak ada yang tertulis di kode.
- **Kunci webhook:** Web App harus dibuka dengan akses "Anyone" agar Telegram bisa memanggilnya. Kunci di query string menolak request yang tidak berasal dari webhook yang didaftarkan. Apps Script tidak memberi akses ke header kustom, sehingga query string adalah opsi yang tersedia. Perlindungannya lebih lemah daripada header, jadi kunci dibuat acak dan panjang.
- **Allowlist pengirim:** hanya satu User ID yang dilayani.
- **Log minimal:** `Debug` mencatat status teknis, bukan isi transaksi.

## Keputusan desain

- **Apps Script, bukan server sendiri:** gratis, tidak perlu hosting, dan terhubung langsung ke Sheets dan Drive.
- **Sheets sebagai database:** data mudah dilihat dan diedit manual, dan Dashboard bisa dibuat langsung dengan rumus.
- **Hapus tanpa konfirmasi dua langkah:** ini bot pribadi, dan salah hapus cukup diperbaiki dengan `lapor` ulang.
- **Satu file kode:** ukurannya kecil, sehingga pemisahan modul belum memberi manfaat.

## Keterbatasan

- Satu pengguna saja.
- Batas kuota Apps Script berlaku, tetapi jauh di atas penggunaan pribadi.
- Perhitungan membaca seluruh sheet `Transaksi` tiap command. Untuk ribuan baris per bulan, perlu pembacaan terbatas atau cache. Belum relevan untuk pemakaian sekarang.

