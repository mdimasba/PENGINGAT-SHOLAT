import * as vscode from 'vscode';
import * as https from 'https';
import * as path from 'path';

// ============================================
// Pengingat Sholat Extension
// By Dimas Bagus
// ============================================

/** Prayer names for MyQuran API */
const PRAYER_KEYS = ['subuh', 'dzuhur', 'ashar', 'maghrib', 'isya'] as const;
type PrayerKey = typeof PRAYER_KEYS[number];

/** Display names for prayers */
const PRAYER_DISPLAY_NAMES: Record<PrayerKey, string> = {
    subuh: 'Subuh',
    dzuhur: 'Dzuhur',
    ashar: 'Ashar',
    maghrib: 'Maghrib',
    isya: 'Isya',
};

/** Interface for prayer schedule from MyQuran API */
interface PrayerSchedule {
    subuh: string;
    dzuhur: string;
    ashar: string;
    maghrib: string;
    isya: string;
    [key: string]: string;
}

/** Interface for cached data */
interface CachedSchedule {
    date: string;
    timings: PrayerSchedule;
    location: string;
}

/** Interface for city data */
interface CityData {
    id: string;
    lokasi: string;
    province?: string;
}

/** Islamic quotes array */
const ISLAMIC_QUOTES: string[] = [
    '"Setiap jiwa akan merasakan kematian. Dan hanya pada hari Kiamat sajalah diberikan balasanmu dengan sempurna." — QS. Ali Imran: 185',
    '"Kehidupan dunia ini tidak lain hanyalah kesenangan yang memperdayakan." — QS. Ali Imran: 185',
    '"Sesungguhnya sholat itu mencegah dari perbuatan keji dan mungkar." — QS. Al-Ankabut: 45',
    '"Tidaklah Aku ciptakan jin dan manusia melainkan agar mereka beribadah kepada-Ku." — QS. Adz-Dzariyat: 56',
    '"Maka ingatlah kepada-Ku, Aku pun akan ingat kepadamu." — QS. Al-Baqarah: 152',
    '"Sesungguhnya bersama kesulitan ada kemudahan." — QS. Al-Insyirah: 6',
    '"Sholat adalah tiang agama." — Hadits Rasulullah ﷺ',
    '"Jadilah engkau di dunia seperti orang asing atau pengembara." — Hadits Rasulullah ﷺ',
    '"Sebaik-baik amal adalah sholat pada awal waktu." — Hadits Rasulullah ﷺ',
    '"Barangsiapa sholat dua waktu yang sejuk (Subuh dan Ashar) maka dia masuk surga." — Hadits Rasulullah ﷺ',
    '"Kehidupan dunia ini hanyalah permainan dan senda gurau. Dan sungguh akhirat itulah kehidupan yang sebenarnya." — QS. Al-Ankabut: 64',
    '"Berlomba-lombalah menuju ampunan dari Tuhanmu dan surga yang luasnya seluas langit dan bumi." — QS. Al-Hadid: 21',
    '"Janganlah kamu tertipu dengan kehidupan dunia." — QS. Fathir: 5',
    '"Kematian sudah cukup sebagai pengingat." — Umar bin Khattab RA',
    '"Kubur adalah tahapan pertama menuju akhirat." — Hadits Rasulullah ﷺ',
    '"Sholatlah sebelum kamu disholatkan." — Hadits Rasulullah ﷺ',
];

/** Reminder messages for each prayer */
const PRAYER_MESSAGES: Record<PrayerKey, string> = {
    subuh: 'Bangun dan segera sholat Subuh. Malaikat-malaikat fajar menyaksikan pengabdianmu kepada Allah.',
    dzuhur: 'Jeda sejenak dari pekerjaanmu dan kembali terhubung dengan Sang Pencipta.',
    ashar: 'Sholat Ashar telah tiba. Jangan biarkan dunia mengalihkan perhatianmu dari yang lebih penting.',
    maghrib: 'Matahari telah terbenam. Segeralah sholat sebelum cahaya Maghrib memudar.',
    isya: 'Akhiri harimu dengan ibadah. Sholat Isya membawa ketenangan bagi jiwa yang gelisah.',
};

let checkInterval: NodeJS.Timeout | undefined;
let statusBarInterval: NodeJS.Timeout | undefined;
let dailyRefreshTimeout: NodeJS.Timeout | undefined;
let currentPanel: vscode.WebviewPanel | undefined;
let triggeredPrayers: Set<string> = new Set();
let triggeredPreReminders: Set<string> = new Set();
let extensionContext: vscode.ExtensionContext;
let statusBarItem: vscode.StatusBarItem | undefined;
let allCities: CityData[] = [];

// ============================================
// ACTIVATION
// ============================================

export function activate(context: vscode.ExtensionContext): void {
    extensionContext = context;
    console.log('[Pengingat Sholat] Extension activated.');

    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'islamicReminder.showPrayerTimes';
    context.subscriptions.push(statusBarItem);

    // Register command: Open Settings
    const openSettingsCmd = vscode.commands.registerCommand(
        'islamicReminder.openSettings',
        () => {
            vscode.commands.executeCommand(
                'workbench.action.openSettings',
                'islamicReminder'
            );
        }
    );

    // Register command: Show Prayer Times
    const showTimesCmd = vscode.commands.registerCommand(
        'islamicReminder.showPrayerTimes',
        async () => {
            await showPrayerTimesInfo();
        }
    );

    // Register command: Select Location
    const selectLocationCmd = vscode.commands.registerCommand(
        'islamicReminder.selectLocation',
        async () => {
            await selectLocationUI();
        }
    );

    context.subscriptions.push(openSettingsCmd, showTimesCmd, selectLocationCmd);

    // Listen for configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('islamicReminder')) {
                console.log('[Pengingat Sholat] Configuration changed. Restarting...');
                stopScheduler();
                startScheduler();
            }
        })
    );

    // Load cities data and start scheduler
    loadCitiesData().then(() => {
        startScheduler();
    });
}

export function deactivate(): void {
    stopScheduler();
    if (statusBarItem) {
        statusBarItem.dispose();
    }
    console.log('[Pengingat Sholat] Extension deactivated.');
}

// ============================================
// SCHEDULER
// ============================================

function startScheduler(): void {
    const config = getConfig();

    if (!config.enableReminder) {
        console.log('[Pengingat Sholat] Reminders are disabled.');
        return;
    }

    if (!config.cityId) {
        vscode.window.showWarningMessage(
            'Pengingat Sholat: Silakan pilih lokasi Anda.',
            'Pilih Lokasi'
        ).then((selection) => {
            if (selection === 'Pilih Lokasi') {
                vscode.commands.executeCommand('islamicReminder.selectLocation');
            }
        });
        return;
    }

    // Fetch schedule immediately
    fetchAndCacheSchedule();

    // Check prayer times every 60 seconds
    checkInterval = setInterval(() => {
        checkPrayerTimes();
    }, 60000);

    // Update status bar every 10 seconds
    statusBarInterval = setInterval(() => {
        updateStatusBar();
    }, 10000);

    // Also check immediately
    setTimeout(() => checkPrayerTimes(), 3000);
    updateStatusBar();

    // Schedule daily refresh at 00:05
    scheduleDailyRefresh();

    console.log('[Pengingat Sholat] Scheduler started.');
}

function stopScheduler(): void {
    if (checkInterval) {
        clearInterval(checkInterval);
        checkInterval = undefined;
    }
    if (statusBarInterval) {
        clearInterval(statusBarInterval);
        statusBarInterval = undefined;
    }
    if (dailyRefreshTimeout) {
        clearTimeout(dailyRefreshTimeout);
        dailyRefreshTimeout = undefined;
    }
    if (statusBarItem) {
        statusBarItem.hide();
    }
    triggeredPrayers.clear();
    triggeredPreReminders.clear();
    console.log('[Pengingat Sholat] Scheduler stopped.');
}

function scheduleDailyRefresh(): void {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 5, 0, 0); // 00:05

    const msUntilRefresh = tomorrow.getTime() - now.getTime();

    dailyRefreshTimeout = setTimeout(() => {
        console.log('[Pengingat Sholat] Daily refresh triggered.');
        triggeredPrayers.clear();
        triggeredPreReminders.clear();
        fetchAndCacheSchedule();
        scheduleDailyRefresh();
    }, msUntilRefresh);

    console.log(`[Pengingat Sholat] Daily refresh scheduled in ${Math.round(msUntilRefresh / 60000)} minutes.`);
}

// ============================================
// CONFIGURATION
// ============================================

interface ExtensionConfig {
    enableReminder: boolean;
    enableSound: boolean;
    enablePreReminder: boolean;
    cityId: string;
    cityName: string;
    provinceName: string;
}

function getConfig(): ExtensionConfig {
    const config = vscode.workspace.getConfiguration('islamicReminder');
    return {
        enableReminder: config.get<boolean>('enableReminder', true),
        enableSound: config.get<boolean>('enableSound', true),
        enablePreReminder: config.get<boolean>('enablePreReminder', true),
        cityId: config.get<string>('cityId', '1301'),
        cityName: config.get<string>('cityName', 'KOTA JAKARTA'),
        provinceName: config.get<string>('provinceName', 'DKI JAKARTA'),
    };
}

// ============================================
// API FETCH
// ============================================

async function fetchAndCacheSchedule(): Promise<PrayerSchedule | null> {
    const config = getConfig();
    const today = getTodayDateString();
    const cacheKey = 'prayerScheduleCache';

    try {
        const cached = extensionContext.globalState.get<CachedSchedule>(cacheKey);
        if (cached && cached.date === today && cached.location === config.cityId && cached.timings) {
            console.log('[Pengingat Sholat] Using cached schedule for today.');
            return cached.timings;
        }
    } catch (e) {
        console.log('[Pengingat Sholat] Cache read error:', e);
    }

    try {
        const [year, month, day] = today.split('-');
        const url = `https://api.myquran.com/v2/sholat/jadwal/${config.cityId}/${year}/${month}/${day}`;

        console.log(`[Pengingat Sholat] Fetching prayer times from MyQuran API...`);
        const data = await httpGet(url);
        const parsed = JSON.parse(data);

        if (parsed.status && parsed.data && parsed.data.jadwal) {
            const jadwal = parsed.data.jadwal;
            const timings: PrayerSchedule = {
                subuh: jadwal.subuh,
                dzuhur: jadwal.dzuhur,
                ashar: jadwal.ashar,
                maghrib: jadwal.maghrib,
                isya: jadwal.isya,
            };

            const cacheData: CachedSchedule = { date: today, timings, location: config.cityId };
            await extensionContext.globalState.update(cacheKey, cacheData);

            console.log('[Pengingat Sholat] Schedule fetched and cached:', timings);
            return timings;
        } else {
            throw new Error('Invalid API response');
        }
    } catch (error) {
        console.error('[Pengingat Sholat] API fetch error:', error);

        try {
            const cached = extensionContext.globalState.get<CachedSchedule>(cacheKey);
            if (cached && cached.timings) {
                vscode.window.showWarningMessage(
                    'Pengingat Sholat: Gagal mengambil jadwal baru. Menggunakan data cache.'
                );
                return cached.timings;
            }
        } catch (e) {
            // No cache available
        }

        vscode.window.showWarningMessage(
            'Pengingat Sholat: Gagal mengambil jadwal sholat. Periksa koneksi internet Anda.'
        );
        return null;
    }
}

/** Simple HTTPS GET request using Node.js built-in https module */
function httpGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const request = https.get(url, (response) => {
            let data = '';
            response.on('data', (chunk: Buffer) => {
                data += chunk.toString();
            });
            response.on('end', () => {
                if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
                    resolve(data);
                } else {
                    reject(new Error(`HTTP ${response.statusCode}: ${data}`));
                }
            });
        });

        request.on('error', (err: Error) => {
            reject(err);
        });

        request.setTimeout(15000, () => {
            request.destroy();
            reject(new Error('Request timeout'));
        });
    });
}

// ============================================
// PRAYER TIME CHECK
// ============================================

async function checkPrayerTimes(): Promise<void> {
    const config = getConfig();
    if (!config.enableReminder) {
        return;
    }

    const schedule = await fetchAndCacheSchedule();
    if (!schedule) {
        return;
    }

    const now = new Date();
    const currentTime = formatTime(now.getHours(), now.getMinutes());
    const today = getTodayDateString();

    // Reset triggered sets if date changed
    const lastDate = extensionContext.globalState.get<string>('lastCheckDate');
    if (lastDate !== today) {
        triggeredPrayers.clear();
        triggeredPreReminders.clear();
        await extensionContext.globalState.update('lastCheckDate', today);
    }

    for (const prayer of PRAYER_KEYS) {
        const prayerTime = schedule[prayer];
        if (!prayerTime) { continue; }

        const prayerKey = `${today}_${prayer}`;

        if (config.enablePreReminder && !triggeredPreReminders.has(prayerKey)) {
            const preTime = subtractMinutes(prayerTime, 5);
            if (currentTime === preTime) {
                triggeredPreReminders.add(prayerKey);
                vscode.window.showInformationMessage(
                    `🕌 ${PRAYER_DISPLAY_NAMES[prayer]} dalam 5 menit (${prayerTime})`
                );
            }
        }

        if (!triggeredPrayers.has(prayerKey) && currentTime === prayerTime) {
            triggeredPrayers.add(prayerKey);
            console.log(`[Pengingat Sholat] Waktu sholat: ${prayer} at ${prayerTime}`);
            showPrayerPopup(prayer, prayerTime);
        }
    }
}

// ============================================
// TIME UTILITIES
// ============================================

function getTodayDateString(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function formatTime(hours: number, minutes: number): string {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function subtractMinutes(time: string, minutes: number): string {
    const [h, m] = time.split(':').map(Number);
    let totalMinutes = h * 60 + m - minutes;
    if (totalMinutes < 0) { totalMinutes += 1440; }
    const newH = Math.floor(totalMinutes / 60) % 24;
    const newM = totalMinutes % 60;
    return formatTime(newH, newM);
}

// ============================================
// SHOW PRAYER TIMES INFO
// ============================================

async function showPrayerTimesInfo(): Promise<void> {
    const schedule = await fetchAndCacheSchedule();
    if (!schedule) {
        vscode.window.showErrorMessage('Pengingat Sholat: Tidak dapat mengambil jadwal sholat.');
        return;
    }

    const config = getConfig();
    const lines: string[] = [
        `Jadwal Sholat - ${config.cityName}`,
        `${config.provinceName}`,
        `Tanggal: ${getTodayDateString()}`,
        '',
    ];

    for (const prayer of PRAYER_KEYS) {
        const time = schedule[prayer] || 'N/A';
        lines.push(`${PRAYER_DISPLAY_NAMES[prayer]}: ${time}`);
    }

    vscode.window.showInformationMessage(lines.join('\n'), { modal: true });
}

// ============================================
// WEBVIEW POPUP
// ============================================

function showPrayerPopup(prayer: PrayerKey, time: string): void {
    if (currentPanel) {
        try { currentPanel.dispose(); } catch (e) { /* ignore */ }
    }

    const config = getConfig();
    const displayName = PRAYER_DISPLAY_NAMES[prayer];
    const quote = ISLAMIC_QUOTES[Math.floor(Math.random() * ISLAMIC_QUOTES.length)];
    const message = PRAYER_MESSAGES[prayer];

    const adzanFile = prayer === 'subuh' ? 'adzan-subuh.mp3' : 'adzan.mp3';

    currentPanel = vscode.window.createWebviewPanel(
        'islamicPrayerReminder',
        `${displayName} Prayer Time`,
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.file(path.join(extensionContext.extensionPath, 'media')),
            ],
        }
    );

    // Get audio URI for webview
    const audioUri = currentPanel.webview.asWebviewUri(
        vscode.Uri.file(path.join(extensionContext.extensionPath, 'media', adzanFile))
    );

    const enableSound = config.enableSound;

    currentPanel.webview.html = getWebviewHtml(
        displayName,
        time,
        message,
        quote,
        audioUri.toString(),
        enableSound
    );

    // Handle messages from webview
    currentPanel.webview.onDidReceiveMessage(
        (msg) => {
            if (msg.command === 'close') {
                if (currentPanel) {
                    currentPanel.dispose();
                    currentPanel = undefined;
                }
            }
        },
        undefined,
        extensionContext.subscriptions
    );

    currentPanel.onDidDispose(() => {
        currentPanel = undefined;
    });
}

// ============================================
// WEBVIEW HTML
// ============================================

function getWebviewHtml(
    prayerName: string,
    time: string,
    message: string,
    quote: string,
    audioSrc: string,
    enableSound: boolean
): string {
    return /*html*/ `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${prayerName} Prayer Time</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Amiri:wght@400;700&family=Poppins:wght@300;400;600;700&display=swap');

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            width: 100vw;
            height: 100vh;
            overflow: hidden;
            display: flex;
            align-items: center;
            justify-content: center;
            background: linear-gradient(135deg, #0a0f1a 0%, #1a1a2e 30%, #16213e 60%, #0f3460 100%);
            font-family: 'Poppins', sans-serif;
            color: #e0e0e0;
            position: relative;
        }

        /* Islamic ornament patterns */
        body::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background:
                radial-gradient(ellipse at 20% 50%, rgba(212, 175, 55, 0.05) 0%, transparent 50%),
                radial-gradient(ellipse at 80% 50%, rgba(212, 175, 55, 0.05) 0%, transparent 50%),
                radial-gradient(circle at 50% 0%, rgba(212, 175, 55, 0.08) 0%, transparent 40%);
            pointer-events: none;
            z-index: 0;
        }

        /* Top ornament border */
        body::after {
            content: '\\2726 \\2726 \\2726 \\2726 \\2726 \\2726 \\2726 \\2726 \\2726';
            position: absolute;
            top: 20px;
            left: 0;
            width: 100%;
            text-align: center;
            font-size: 18px;
            color: rgba(212, 175, 55, 0.3);
            letter-spacing: 20px;
            pointer-events: none;
            z-index: 0;
        }

        .container {
            text-align: center;
            z-index: 1;
            padding: 40px;
            max-width: 700px;
            width: 90%;
            animation: fadeIn 1s ease-out;
        }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(30px); }
            to { opacity: 1; transform: translateY(0); }
        }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.7; }
        }

        .bismillah {
            font-family: 'Amiri', serif;
            font-size: 28px;
            color: #d4af37;
            margin-bottom: 10px;
            letter-spacing: 2px;
        }

        .ornament-line {
            width: 200px;
            height: 2px;
            background: linear-gradient(90deg, transparent, #d4af37, transparent);
            margin: 15px auto;
            border-radius: 1px;
        }

        .prayer-label {
            font-size: 16px;
            text-transform: uppercase;
            letter-spacing: 6px;
            color: #d4af37;
            margin-bottom: 8px;
            font-weight: 300;
        }

        .prayer-name {
            font-family: 'Amiri', serif;
            font-size: 64px;
            font-weight: 700;
            color: #ffffff;
            text-shadow: 0 0 40px rgba(212, 175, 55, 0.3);
            margin-bottom: 5px;
        }

        .prayer-time {
            font-size: 42px;
            font-weight: 600;
            color: #d4af37;
            margin-bottom: 20px;
            animation: pulse 2s infinite;
        }

        .message {
            font-size: 16px;
            line-height: 1.8;
            color: #b0b0b0;
            margin-bottom: 25px;
            font-weight: 300;
            padding: 0 20px;
        }

        .quote-container {
            background: rgba(212, 175, 55, 0.08);
            border-left: 3px solid #d4af37;
            border-radius: 0 8px 8px 0;
            padding: 20px 25px;
            margin: 25px 0;
            text-align: left;
        }

        .quote {
            font-family: 'Amiri', serif;
            font-size: 17px;
            line-height: 1.8;
            color: #c9b06b;
            font-style: italic;
        }

        .close-btn {
            margin-top: 30px;
            padding: 14px 60px;
            font-size: 16px;
            font-family: 'Poppins', sans-serif;
            font-weight: 600;
            letter-spacing: 2px;
            text-transform: uppercase;
            color: #0a0f1a;
            background: linear-gradient(135deg, #d4af37, #f0d060);
            border: none;
            border-radius: 50px;
            cursor: pointer;
            transition: all 0.3s ease;
            box-shadow: 0 4px 20px rgba(212, 175, 55, 0.3);
        }

        .close-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 30px rgba(212, 175, 55, 0.5);
        }

        .close-btn:active {
            transform: translateY(0);
        }

        /* Bottom ornament */
        .bottom-ornament {
            position: absolute;
            bottom: 20px;
            left: 0;
            width: 100%;
            text-align: center;
            font-size: 18px;
            color: rgba(212, 175, 55, 0.3);
            letter-spacing: 20px;
            pointer-events: none;
        }

        /* Stars decoration */
        .star {
            position: absolute;
            width: 3px;
            height: 3px;
            background: rgba(212, 175, 55, 0.4);
            border-radius: 50%;
            animation: twinkle 3s infinite;
        }

        @keyframes twinkle {
            0%, 100% { opacity: 0.2; }
            50% { opacity: 1; }
        }
    </style>
</head>
<body>
    <!-- Decorative stars -->
    <div class="star" style="top:10%;left:15%;animation-delay:0s"></div>
    <div class="star" style="top:25%;left:85%;animation-delay:0.5s"></div>
    <div class="star" style="top:60%;left:10%;animation-delay:1s"></div>
    <div class="star" style="top:75%;left:90%;animation-delay:1.5s"></div>
    <div class="star" style="top:40%;left:5%;animation-delay:2s"></div>
    <div class="star" style="top:15%;left:70%;animation-delay:0.3s"></div>
    <div class="star" style="top:85%;left:30%;animation-delay:0.8s"></div>
    <div class="star" style="top:50%;left:95%;animation-delay:1.2s"></div>

    <div class="container">
        <div class="bismillah">بِسْمِ اللَّهِ الرَّحْمَنِ الرَّحِيمِ</div>

        <div class="ornament-line"></div>

        <div class="prayer-label">It's Time for</div>
        <div class="prayer-name">${prayerName}</div>
        <div class="prayer-time">${time}</div>

        <div class="message">${message}</div>

        <div class="quote-container">
            <div class="quote">${quote}</div>
        </div>

        <div class="ornament-line"></div>

        <button class="close-btn" onclick="closePopup()">Close</button>
    </div>

    <div class="bottom-ornament">✦ ✦ ✦ ✦ ✦ ✦ ✦ ✦ ✦</div>

    ${enableSound ? `<audio id="adzanAudio" src="${audioSrc}" preload="auto"></audio>` : ''}

    <script>
        const vscode = acquireVsCodeApi();

        // Disable ESC key to prevent accidental close
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
            }
        });

        // Try to play audio
        ${enableSound ? `
        (function() {
            const audio = document.getElementById('adzanAudio');
            if (audio) {
                audio.play().catch(function(err) {
                    console.log('Audio autoplay blocked:', err);
                });
            }
        })();
        ` : ''}

        function closePopup() {
            ${enableSound ? `
            const audio = document.getElementById('adzanAudio');
            if (audio) {
                audio.pause();
                audio.currentTime = 0;
            }
            ` : ''}
            vscode.postMessage({ command: 'close' });
        }
    </script>
</body>
</html>`;
}

// ============================================
// LOAD CITIES DATA
// ============================================

async function loadCitiesData(): Promise<void> {
    try {
        console.log('[Pengingat Sholat] Loading cities data...');
        const data = await httpGet('https://api.myquran.com/v2/sholat/kota/semua');
        const parsed = JSON.parse(data);
        
        if (parsed.status && parsed.data && Array.isArray(parsed.data)) {
            allCities = parsed.data.map((city: any) => ({
                id: city.id,
                lokasi: city.lokasi,
            }));
            
            groupCitiesByProvince();
            console.log(`[Pengingat Sholat] Loaded ${allCities.length} cities.`);
        }
    } catch (error) {
        console.error('[Pengingat Sholat] Failed to load cities:', error);
        vscode.window.showWarningMessage('Pengingat Sholat: Gagal memuat data kota.');
    }
}

function groupCitiesByProvince(): void {
    const provinceMap = new Map<string, CityData[]>();
    
    for (const city of allCities) {
        const parts = city.lokasi.split(' ');
        let province = '';
        
        if (city.id.startsWith('01')) { province = 'ACEH'; }
        else if (city.id.startsWith('02')) { province = 'SUMATERA UTARA'; }
        else if (city.id.startsWith('03')) { province = 'SUMATERA BARAT'; }
        else if (city.id.startsWith('04')) { province = 'RIAU'; }
        else if (city.id.startsWith('05')) { province = 'KEPULAUAN RIAU'; }
        else if (city.id.startsWith('06')) { province = 'JAMBI'; }
        else if (city.id.startsWith('07')) { province = 'BENGKULU'; }
        else if (city.id.startsWith('08')) { province = 'SUMATERA SELATAN'; }
        else if (city.id.startsWith('09')) { province = 'BANGKA BELITUNG'; }
        else if (city.id.startsWith('10')) { province = 'LAMPUNG'; }
        else if (city.id.startsWith('11')) { province = 'BANTEN'; }
        else if (city.id.startsWith('12')) { province = 'JAWA BARAT'; }
        else if (city.id.startsWith('13')) { province = 'DKI JAKARTA'; }
        else if (city.id.startsWith('14')) { province = 'JAWA TENGAH'; }
        else if (city.id.startsWith('15')) { province = 'DI YOGYAKARTA'; }
        else if (city.id.startsWith('16')) { province = 'JAWA TIMUR'; }
        else if (city.id.startsWith('17')) { province = 'BALI'; }
        else if (city.id.startsWith('18')) { province = 'NUSA TENGGARA BARAT'; }
        else if (city.id.startsWith('19')) { province = 'NUSA TENGGARA TIMUR'; }
        else if (city.id.startsWith('20')) { province = 'KALIMANTAN BARAT'; }
        else if (city.id.startsWith('21')) { province = 'KALIMANTAN SELATAN'; }
        else if (city.id.startsWith('22')) { province = 'KALIMANTAN TENGAH'; }
        else if (city.id.startsWith('23')) { province = 'KALIMANTAN TIMUR'; }
        else if (city.id.startsWith('24')) { province = 'KALIMANTAN UTARA'; }
        else if (city.id.startsWith('25')) { province = 'GORONTALO'; }
        else if (city.id.startsWith('26')) { province = 'SULAWESI SELATAN'; }
        else if (city.id.startsWith('27')) { province = 'SULAWESI TENGGARA'; }
        else if (city.id.startsWith('28')) { province = 'SULAWESI TENGAH'; }
        else if (city.id.startsWith('29')) { province = 'SULAWESI UTARA'; }
        else if (city.id.startsWith('30')) { province = 'SULAWESI BARAT'; }
        else if (city.id.startsWith('31')) { province = 'MALUKU'; }
        else if (city.id.startsWith('32')) { province = 'MALUKU UTARA'; }
        else if (city.id.startsWith('33')) { province = 'PAPUA'; }
        else if (city.id.startsWith('34')) { province = 'PAPUA BARAT'; }
        
        city.province = province;
        
        if (!provinceMap.has(province)) {
            provinceMap.set(province, []);
        }
        provinceMap.get(province)!.push(city);
    }
}

// ============================================
// LOCATION SELECTION UI
// ============================================

async function selectLocationUI(): Promise<void> {
    if (allCities.length === 0) {
        vscode.window.showWarningMessage('Pengingat Sholat: Data kota belum dimuat. Tunggu sebentar...');
        await loadCitiesData();
        if (allCities.length === 0) {
            return;
        }
    }
    
    const provinces = Array.from(new Set(allCities.map(c => c.province).filter((p): p is string => !!p)));
    provinces.sort();
    
    const selectedProvince = await vscode.window.showQuickPick(provinces, {
        placeHolder: 'Pilih Provinsi',
        title: 'Pengingat Sholat - Pilih Lokasi (1/2)',
    });
    
    if (!selectedProvince) {
        return;
    }
    
    const citiesInProvince = allCities.filter(c => c.province === selectedProvince);
    citiesInProvince.sort((a, b) => a.lokasi.localeCompare(b.lokasi));
    
    const cityItems = citiesInProvince.map(c => ({
        label: c.lokasi,
        description: `ID: ${c.id}`,
        city: c,
    }));
    
    const selectedCity = await vscode.window.showQuickPick(cityItems, {
        placeHolder: 'Pilih Kota/Kabupaten',
        title: `Pengingat Sholat - ${selectedProvince} (2/2)`,
    });
    
    if (!selectedCity) {
        return;
    }
    
    const config = vscode.workspace.getConfiguration('islamicReminder');
    await config.update('cityId', selectedCity.city.id, vscode.ConfigurationTarget.Global);
    await config.update('cityName', selectedCity.city.lokasi, vscode.ConfigurationTarget.Global);
    await config.update('provinceName', selectedProvince, vscode.ConfigurationTarget.Global);
    
    vscode.window.showInformationMessage(
        `Lokasi diatur: ${selectedCity.city.lokasi}, ${selectedProvince}`
    );
}

// ============================================
// STATUS BAR UPDATE
// ============================================

async function updateStatusBar(): Promise<void> {
    if (!statusBarItem) {
        return;
    }
    
    const config = getConfig();
    if (!config.enableReminder) {
        statusBarItem.hide();
        return;
    }
    
    const schedule = await fetchAndCacheSchedule();
    if (!schedule) {
        statusBarItem.text = '🕌 Pengingat Sholat';
        statusBarItem.tooltip = 'Klik untuk melihat jadwal';
        statusBarItem.show();
        return;
    }
    
    const nextPrayer = getNextPrayer(schedule);
    if (!nextPrayer) {
        statusBarItem.text = '🕌 Tidak ada jadwal';
        statusBarItem.show();
        return;
    }
    
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const [prayerH, prayerM] = nextPrayer.time.split(':').map(Number);
    const prayerMinutes = prayerH * 60 + prayerM;
    
    let diff = prayerMinutes - currentMinutes;
    if (diff < 0) {
        diff += 1440;
    }
    
    const hours = Math.floor(diff / 60);
    const minutes = diff % 60;
    
    let timeText = '';
    if (hours > 0) {
        timeText = `${hours} jam ${minutes} menit`;
    } else {
        timeText = `${minutes} menit`;
    }
    
    statusBarItem.text = `🕌 ${nextPrayer.name}: ${timeText}`;
    statusBarItem.tooltip = `Waktu ${nextPrayer.name}: ${nextPrayer.time}\nKlik untuk melihat jadwal lengkap`;
    statusBarItem.show();
}

function getNextPrayer(schedule: PrayerSchedule): { name: string; time: string } | null {
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    
    for (const prayer of PRAYER_KEYS) {
        const time = schedule[prayer];
        if (!time) { continue; }
        
        const [h, m] = time.split(':').map(Number);
        const prayerMinutes = h * 60 + m;
        
        if (prayerMinutes > currentMinutes) {
            return {
                name: PRAYER_DISPLAY_NAMES[prayer],
                time,
            };
        }
    }
    
    return {
        name: PRAYER_DISPLAY_NAMES['subuh'],
        time: schedule['subuh'],
    };
}
