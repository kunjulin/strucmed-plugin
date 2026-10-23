import { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';
import '../styles/BarcodeScanner.css';

interface BarcodeScannerProps {
  onScan: (text: string) => void;
  onClose: () => void;
}

const BarcodeScanner = ({ onScan, onClose }: BarcodeScannerProps) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState<boolean>(true);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  // 保存媒體流引用
  const streamRef = useRef<MediaStream | null>(null);
  // 使用 ref 標記掃描狀態，避免多次觸發回調
  const scannedRef = useRef<boolean>(false);
  // 掃描結果和確認對話框
  const [scanResult, setScanResult] = useState<string | null>(null);
  const [showResultDialog, setShowResultDialog] = useState<boolean>(false);

  // 釋放相機資源的函數
  const releaseCamera = () => {
    try {
      // 停止所有媒體軌道
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => {
          track.stop();
        });
        streamRef.current = null;
      }

      // 清除視頻元素
      if (videoRef.current && videoRef.current.srcObject) {
        videoRef.current.srcObject = null;
      }
    } catch (e) {
      console.error('釋放相機資源出錯:', e);
    }
  };

  // 處理組件關閉
  const handleClose = () => {
    releaseCamera();
    onClose();
  };

  // 處理確認掃描結果
  const handleConfirmResult = () => {
    if (scanResult) {
      console.log('確認掃描結果:', scanResult); // 記錄確認的結果
      // 關閉結果對話框
      setShowResultDialog(false);
      // 立即釋放相機資源
      releaseCamera();
      // 回調結果給父組件
      onScan(scanResult);
    }
  };

  useEffect(() => {
    // 只有在scanning為true時才啟動相機
    if (!scanning) {
      return;
    }

    // 重置掃描標記
    scannedRef.current = false;
    setScanResult(null);
    setShowResultDialog(false);

    // 配置條碼讀取器
    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [
      BarcodeFormat.CODE_128,
      BarcodeFormat.QR_CODE,
      BarcodeFormat.EAN_13,
      BarcodeFormat.EAN_8,
      BarcodeFormat.CODE_39,
      BarcodeFormat.DATA_MATRIX
    ]);
    
    const reader = new BrowserMultiFormatReader(hints);
    readerRef.current = reader;

    const startScanner = async () => {
      try {
        if (!videoRef.current) return;
        
        // 使用後鏡頭（環境相機）
        const constraints = {
          video: { 
            facingMode: 'environment',
            width: { ideal: 1280 },
            height: { ideal: 720 }
          }
        };

        // 解碼成功回調
        const onDecodeSuccess = (result: any) => {
          // 使用 scannedRef 避免多次觸發
          if (result && result.getText && !scannedRef.current) {
            const text = result.getText();
            if (text) {
              // 立即標記為已掃描，防止多次觸發
              scannedRef.current = true;
              
              setScanning(false);
              // 震動提示
              if (navigator.vibrate) {
                navigator.vibrate(200);
              }
              // 播放提示音
              playBeepSound();
              
              // 暫停視頻播放但不釋放資源
              if (videoRef.current) {
                videoRef.current.pause();
              }
              
              // 設置掃描結果並顯示確認對話框
              console.log('掃描結果:', text); // 記錄掃描結果
              setScanResult(text);
              setShowResultDialog(true);
            }
          }
        };

        // 開始從視頻設備解碼
        try {
          // 儲存媒體流以便之後能夠釋放
          const result = await reader.decodeFromVideoDevice(
            undefined, // 使用默認設備
            videoRef.current, 
            onDecodeSuccess
          );
          
          // 獲取並保存當前媒體流引用
          if (videoRef.current && videoRef.current.srcObject instanceof MediaStream) {
            streamRef.current = videoRef.current.srcObject;
          }
        } catch (e) {
          console.error('啟動解碼器出錯:', e);
          throw e;
        }
      } catch (err) {
        console.error('初始化相機出錯:', err);
        setError('無法啟動相機。請確保已授權相機權限。');
        releaseCamera();
      }
    };

    startScanner();

    // 清理資源
    return () => {
      releaseCamera();
    };
  }, [onScan, scanning]);

  const restartScanner = () => {
    // 先釋放之前的資源
    releaseCamera();
    // 重設狀態
    setError(null);
    setScanResult(null);
    setShowResultDialog(false);
    // 重置掃描標記
    scannedRef.current = false;
    setScanning(true);
  };

  const playBeepSound = () => {
    // 建立提示音
    try {
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();
      
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(1800, audioContext.currentTime);
      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);
      
      gainNode.gain.setValueAtTime(0.5, audioContext.currentTime);
      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.1);
    } catch (e) {
      console.error('播放提示音失敗:', e);
    }
  };

  return (
    <div className="barcode-scanner">
      <div className="scanner-header">
        <h3>掃描條碼　　　　　　　　　　</h3>
        <button className="close-button" onClick={handleClose} aria-label="關閉" title="關閉">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
      
      <div className="scanner-viewport">
        {error ? (
          <div className="scanner-error">{error}</div>
        ) : (
          <>
            <video ref={videoRef} className="scanner-video" playsInline></video>
            <div className="targeting-box"></div>
            <div className="scanning-line" style={{ display: scanning ? 'block' : 'none' }}></div>
            
            {/* 掃描結果確認對話框 */}
            {showResultDialog && (
              <div className="scan-result-dialog">
                <div className="scan-result-content">
                  <h4>掃描結果</h4>
                  <div className="scan-result-text">
                    {scanResult ? scanResult : '無掃描結果'}
                  </div>
                  <div className="scan-result-actions">
                    <button 
                      onClick={handleConfirmResult} 
                      className="confirm-button"
                      disabled={!scanResult}
                    >
                      確認
                    </button>
                    <button onClick={restartScanner} className="cancel-button">
                      重新掃描
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
      
      <div className="scanner-actions">
        {!scanning && !showResultDialog && (
          <button className="restart-button" onClick={restartScanner}>
            重新掃描
          </button>
        )}
        {error && (
          <button className="restart-button" onClick={restartScanner}>
            重試
          </button>
        )}
      </div>
    </div>
  );
};

export default BarcodeScanner; 