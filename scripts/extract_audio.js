#!/usr/bin/env node
/**
 * أداة استخراج الصوت من ملفات الفيديو أو الروابط
 *
 * الاستخدام:
 *   node scripts/extract_audio.js <ملف أو رابط> [خيارات]
 *
 * الخيارات:
 *   --format, -f   صيغة الإخراج: mp3 | wav | m4a | aac | ogg | flac  (الافتراضي: mp3)
 *   --out, -o      مسار ملف الإخراج (الافتراضي: نفس اسم الملف بالصيغة الجديدة)
 *   --start        بداية المقطع (مثال: 00:00:05 أو 5)
 *   --end          نهاية المقطع (مثال: 00:00:30)
 *   --bitrate, -b  معدل البت للصيغ المضغوطة (الافتراضي: 192k)
 *
 * أمثلة:
 *   node scripts/extract_audio.js video.mp4
 *   node scripts/extract_audio.js video.mp4 -f wav -o voice.wav
 *   node scripts/extract_audio.js clip.mov --start 10 --end 40
 *   node scripts/extract_audio.js "https://www.tiktok.com/@user/video/123"
 *
 * المتطلبات: ffmpeg (وyt-dlp للروابط فقط).
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CODECS = {
    mp3: ['-c:a', 'libmp3lame'],
    m4a: ['-c:a', 'aac'],
    aac: ['-c:a', 'aac'],
    ogg: ['-c:a', 'libvorbis'],
    wav: ['-c:a', 'pcm_s16le'],
    flac: ['-c:a', 'flac']
};
const LOSSLESS = new Set(['wav', 'flac']);

function parseArgs(argv) {
    const opts = { format: 'mp3', bitrate: '192k' };
    const aliases = { f: 'format', o: 'out', b: 'bitrate' };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg.startsWith('-')) {
            const key = arg.replace(/^-+/, '');
            opts[aliases[key] || key] = argv[++i];
        } else if (!opts.input) {
            opts.input = arg;
        }
    }
    return opts;
}

function hasCommand(cmd) {
    return spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0
        || spawnSync(cmd, ['-version'], { stdio: 'ignore' }).status === 0;
}

function run(cmd, args) {
    const result = spawnSync(cmd, args, { stdio: 'inherit' });
    if (result.status !== 0) {
        console.error(`❌ فشل تنفيذ ${cmd}`);
        process.exit(result.status || 1);
    }
}

function downloadUrl(url) {
    if (!hasCommand('yt-dlp')) {
        console.error('❌ yt-dlp غير مثبت. ثبّته بالأمر: pip install yt-dlp');
        process.exit(1);
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-audio-'));
    console.log('⬇️  جاري تنزيل الصوت من الرابط...');
    run('yt-dlp', ['-f', 'bestaudio/best', '-o', path.join(dir, '%(title).80s.%(ext)s'), url]);
    const file = fs.readdirSync(dir)[0];
    return path.join(dir, file);
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (!opts.input) {
        console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
        process.exit(1);
    }
    if (!hasCommand('ffmpeg')) {
        console.error('❌ ffmpeg غير مثبت. ثبّته بالأمر: sudo apt install ffmpeg');
        process.exit(1);
    }

    const format = opts.format.toLowerCase();
    if (!CODECS[format]) {
        console.error(`❌ صيغة غير مدعومة: ${format}. المتاح: ${Object.keys(CODECS).join(', ')}`);
        process.exit(1);
    }

    const isUrl = /^https?:\/\//i.test(opts.input);
    const source = isUrl ? downloadUrl(opts.input) : path.resolve(opts.input);
    if (!fs.existsSync(source)) {
        console.error(`❌ الملف غير موجود: ${source}`);
        process.exit(1);
    }

    const baseName = path.basename(source, path.extname(source));
    const outDir = isUrl ? process.cwd() : path.dirname(source);
    const output = path.resolve(opts.out || path.join(outDir, `${baseName}.${format}`));

    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-stats'];
    if (opts.start) args.push('-ss', opts.start);
    if (opts.end) args.push('-to', opts.end);
    args.push('-i', source, '-vn', ...CODECS[format]);
    if (!LOSSLESS.has(format)) args.push('-b:a', opts.bitrate);
    args.push(output);

    console.log(`🎵 جاري استخراج الصوت إلى ${format.toUpperCase()}...`);
    run('ffmpeg', args);
    if (isUrl) fs.rmSync(path.dirname(source), { recursive: true, force: true });

    const sizeMb = (fs.statSync(output).size / 1024 / 1024).toFixed(2);
    console.log(`✅ تم الاستخراج: ${output} (${sizeMb} MB)`);
}

main();
