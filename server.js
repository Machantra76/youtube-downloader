const express = require('express');
const cors = require('cors');
const ytdl = require('ytdl-core');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

// បង្ហាញ Frontend ពី Folder public
app.use(express.static(path.join(__dirname, 'public')));

// API សម្រាប់ទាញយកវីដេអូ YouTube
app.get('/download', async (req, res) => {
    try {
        const videoURL = req.query.url;
        const quality = req.query.quality || 'highest'; // highest ឬ lowest

        if (!ytdl.validateURL(videoURL)) {
            return res.status(400).json({ success: false, error: 'ลิงก์ YouTube មិនត្រឹមត្រូវទេ!' });
        }

        // យកព័ត៌មានវីដេអូសម្រាប់ដាក់ឈ្មោះ ፋይል
        const info = await ytdl.getInfo(videoURL);
        const title = info.videoDetails.title.replace(/[^\w\s]/gi, ''); // កាត់អក្សរពិសេសចេញពីឈ្មោះ

        res.header('Content-Disposition', `attachment; filename="${title}.mp4"`);
        
        // ផ្ដល់ទិន្នន័យវីដេអូទៅ Browser ជា Stream
        ytdl(videoURL, { quality: quality, filter: 'videoandaudio' }).pipe(res);

    } catch (err) {
        console.error("Download Error:", err);
        res.status(500).json({ success: false, error: 'មានបញ្ហាក្នុងการទាញយកវីដេអូ!' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`YouTube Downloader Server is running on port ${PORT}`);
});