# Web PPG Monitor & Analysis

Aplikasi web untuk monitoring dan analisis data Photoplethysmography (PPG) real-time dari Arduino Nano.

## Fitur

- 🔌 Auto-detect COM port Arduino Nano
- 📊 Visualisasi sinyal PPG real-time
- ❤️ Perhitungan Heart Rate otomatis
- ⏱️ Analisis Heart Rate Variability (HRV)
- 🔬 Estimasi SpO2
- 📈 Statistik data real-time
- 🎨 Interface modern dan responsif

## Instalasi

1. Install dependencies:
```bash
npm install
```

2. Jalankan server:
```bash
npm start
```

3. Buka browser dan akses:
```
http://localhost:3000
```

## Cara Penggunaan

1. **Hubungkan Arduino Nano** ke komputer via USB
2. **Refresh Port** - Klik tombol refresh untuk memuat daftar COM port
3. **Pilih COM Port** - Pilih port dimana Arduino terhubung (biasanya /dev/tty.usbserial-* di Mac)
4. **Pilih Baud Rate** - Sesuaikan dengan setting di Arduino (default: 9600)
5. **Hubungkan** - Klik tombol "Hubungkan"
6. Data PPG akan mulai ditampilkan secara real-time

## Format Data Arduino

Arduino harus mengirim data dalam format:
```
nilai\n
```

Contoh output serial monitor Arduino:
```
512
515
518
...
```

Setiap nilai harus dipisahkan dengan newline (`\n`).

## Contoh Code Arduino (Basic)

```cpp
void setup() {
  Serial.begin(9600);
  pinMode(A0, INPUT);  // Sensor PPG di pin A0
}

void loop() {
  int sensorValue = analogRead(A0);
  Serial.println(sensorValue);
  delay(20);  // Sampling rate ~50Hz
}
```

## Teknologi yang Digunakan

- **Backend**: Node.js, Express, Socket.IO, SerialPort
- **Frontend**: HTML5, CSS3, JavaScript, Chart.js
- **Real-time Communication**: WebSocket (Socket.IO)

## Analisis PPG

Aplikasi ini melakukan beberapa analisis:

1. **Peak Detection**: Mendeteksi puncak sinyal untuk menghitung detak jantung
2. **Heart Rate**: Dihitung dari interval antar puncak (RR interval)
3. **HRV**: Variabilitas heart rate dari standar deviasi RR interval
4. **Signal Quality**: Penilaian kualitas sinyal berdasarkan amplitudo
5. **SpO2 Estimation**: Estimasi kasar saturasi oksigen (perlu sensor dual-wavelength untuk akurasi)

## Troubleshooting

### Port tidak terdeteksi
- Pastikan Arduino sudah terhubung
- Pastikan driver CH340/FTDI sudah terinstall
- Coba cabut dan colok ulang USB

### Data tidak muncul
- Periksa baud rate sama dengan setting Arduino
- Pastikan Arduino mengirim data dengan format yang benar
- Buka Serial Monitor Arduino untuk memastikan data terkirim

### Error "Access Denied"
- Tutup aplikasi lain yang menggunakan serial port (Arduino IDE, Serial Monitor, dll)
- Di macOS, mungkin perlu memberikan permission ke Terminal/Node

## Pengembangan Lebih Lanjut

Untuk development dengan auto-reload:
```bash
npm run dev
```

## Lisensi

ISC
