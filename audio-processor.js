import prism from 'prism-media';

const { opus: { WebmDemuxer } } = prism;

/**
 * Extract Opus frames from WebM container using prism-media's demuxer
 */
export class WebMOpusExtractor {
  async extractOpusFrames(webmData) {
    // Upstream libraries expect a WebM file with an EBML header, but
    // MediaRecorder may emit pure Opus packets when the fragment is small.
    // Detect this case and return the audio payload directly.
    if (webmData.length > 0 && webmData[0] !== 0x1A) {
      return [Buffer.from(webmData)];
    }

    const demuxer = new WebmDemuxer();
    const frames = [];

    return new Promise((resolve, reject) => {
      demuxer.once('error', reject);
      demuxer.on('data', (chunk) => {
        frames.push(Buffer.from(chunk));
      });
      demuxer.on('end', () => resolve(frames));

      demuxer.end(webmData);
    });
  }
}

/**
 * Wrap raw Opus frames in Ogg container for browser playback
 * Ogg format: OggS pages with Opus packets
 */
export class OggOpusWrapper {
  constructor() {
    this.sequenceNumber = 0;
    this.granulePosition = 0;
  }

  /**
   * Create Ogg Opus file from raw Opus packets
   * Each call creates a complete, standalone Ogg Opus file
   * This is needed because browser Audio API requires complete files
   * 
   * @param {Buffer[]} opusFrames - Array of raw Opus packets
   * @param {number} sampleRate - Sample rate (default 48000)
   * @returns {Buffer} Complete Ogg Opus file
   */
  wrapInOgg(opusFrames, sampleRate = 48000) {
    // Reset for each file (each packet is independent)
    this.reset();
    
    const pages = [];
    
    // Create Ogg Opus Identification Header (required)
    pages.push(this.createIdentificationHeader());
    
    // Create Ogg Opus Comment Header (required)
    pages.push(this.createCommentHeader());
    
    // Wrap each Opus frame in Ogg page
    opusFrames.forEach((frame, index) => {
      const isLast = index === opusFrames.length - 1;
      pages.push(this.createAudioPage(frame, sampleRate, isLast));
    });
    
    return Buffer.concat(pages);
  }

  createIdentificationHeader() {
    const header = Buffer.alloc(47);
    let offset = 0;
    
    // Ogg page header
    header.write('OggS', offset); offset += 4; // Capture pattern
    header.writeUInt8(0, offset++); // Version
    header.writeUInt8(0x02, offset++); // Header type (beginning of stream)
    header.writeBigUInt64LE(0n, offset); offset += 8; // Granule position
    header.writeUInt32LE(this.serialNumber, offset); offset += 4; // Serial number
    header.writeUInt32LE(this.sequenceNumber++, offset); offset += 4; // Sequence number
    header.writeUInt32LE(0, offset); offset += 4; // Checksum (calculated later)
    header.writeUInt8(1, offset++); // Number of segments
    header.writeUInt8(19, offset++); // Segment table (19 bytes)
    
    // Opus Identification Header
    header.write('OpusHead', offset); offset += 8;
    header.writeUInt8(1, offset++); // Version
    header.writeUInt8(1, offset++); // Channel count (MONO - Simple Voice Chat uses mono)
    header.writeUInt16LE(0, offset); offset += 2; // Pre-skip (per-packet stream, no trim)
    header.writeUInt32LE(48000, offset); offset += 4; // Input sample rate
    header.writeUInt16LE(0, offset); offset += 2; // Output gain
    header.writeUInt8(0, offset++); // Channel mapping family
    
    // Calculate and set checksum
    this.setChecksum(header);
    
    return header;
  }

  createCommentHeader() {
    const vendor = 'Voicebed';
    const payload = Buffer.alloc(8 + 4 + vendor.length + 4);
    let payloadOffset = 0;
    payload.write('OpusTags', payloadOffset); payloadOffset += 8;
    payload.writeUInt32LE(vendor.length, payloadOffset); payloadOffset += 4;
    payload.write(vendor, payloadOffset); payloadOffset += vendor.length;
    payload.writeUInt32LE(0, payloadOffset); payloadOffset += 4;

    const segments = this.createSegmentTable(payload.length);
    const headerSize = 27 + segments.length + payload.length;
    const header = Buffer.alloc(headerSize);
    let offset = 0;
    
    // Ogg page header
    header.write('OggS', offset); offset += 4;
    header.writeUInt8(0, offset++);
    header.writeUInt8(0x00, offset++);
    header.writeBigUInt64LE(0n, offset); offset += 8;
    header.writeUInt32LE(this.serialNumber, offset); offset += 4;
    header.writeUInt32LE(this.sequenceNumber++, offset); offset += 4;
    header.writeUInt32LE(0, offset); offset += 4; // Checksum placeholder
    header.writeUInt8(segments.length, offset++); // Number of segments
    for (const segment of segments) {
      header.writeUInt8(segment, offset++);
    }
    
    // Opus Comment Header payload
    payload.copy(header, offset);
    offset += payload.length;
    
    this.setChecksum(header);
    
    return header;
  }

  createAudioPage(opusFrame, sampleRate, isLastPage = false) {
    const samplesPerFrame = this.estimateSamplesPerFrame(opusFrame, sampleRate);
    this.granulePosition += samplesPerFrame;
    
    const segments = this.createSegmentTable(opusFrame.length);
    
    const numSegments = segments.length;
    const pageSize = 27 + numSegments + opusFrame.length;
    const page = Buffer.alloc(pageSize);
    let offset = 0;
    
    // Ogg page header
    page.write('OggS', offset); offset += 4;
    page.writeUInt8(0, offset++); // Version
    page.writeUInt8(isLastPage ? 0x04 : 0x00, offset++); // Header type (end of stream for final page)
    page.writeBigUInt64LE(BigInt(this.granulePosition), offset); offset += 8;
    page.writeUInt32LE(this.serialNumber, offset); offset += 4; // Serial number
    page.writeUInt32LE(this.sequenceNumber++, offset); offset += 4;
    page.writeUInt32LE(0, offset); offset += 4; // Checksum placeholder
    page.writeUInt8(numSegments, offset++); // Number of segments
    
    // Segment table
    for (const segmentSize of segments) {
      page.writeUInt8(segmentSize, offset++);
    }
    
    // Opus frame data
    opusFrame.copy(page, offset);
    
    this.setChecksum(page);
    
    return page;
  }

  setChecksum(page) {
    // CRC-32 calculation for Ogg
    const crcTable = this.getCRCTable();
    let crc = 0;
    
    // Set checksum field to 0 for calculation
    page.writeUInt32LE(0, 22);
    
    for (let i = 0; i < page.length; i++) {
      crc = (((crc << 8) >>> 0) ^ crcTable[((crc >>> 24) ^ page[i]) & 0xFF]) >>> 0;
    }
    
    page.writeUInt32LE(crc >>> 0, 22);
  }

  createSegmentTable(length) {
    const segments = [];
    let remaining = length;
    while (remaining > 0) {
      const segmentSize = Math.min(remaining, 255);
      segments.push(segmentSize);
      remaining -= segmentSize;
    }
    return segments;
  }

  estimateSamplesPerFrame(opusFrame, sampleRate) {
    // Simple Voice Chat sends 20ms Opus frames at 48kHz (960 samples)
    // Keep a conservative default in case of missing data
    return Math.floor(sampleRate * 0.02);
  }

  getCRCTable() {
    if (!this.crcTable) {
      this.crcTable = [];
      for (let i = 0; i < 256; i++) {
        let r = i << 24;
        for (let j = 0; j < 8; j++) {
          r = (r & 0x80000000) ? ((r << 1) ^ 0x04C11DB7) : (r << 1);
        }
        this.crcTable[i] = r >>> 0;
      }
    }
    return this.crcTable;
  }

  reset() {
    this.sequenceNumber = 0;
    this.granulePosition = 0;
    this.serialNumber = Math.floor(Math.random() * 0xFFFFFFFF);
  }
}

export default { WebMOpusExtractor, OggOpusWrapper };
