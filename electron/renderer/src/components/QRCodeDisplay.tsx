import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { useTheme } from '../context/ThemeContext';
import '../styles/feed.css';

interface QRCodeDisplayProps {
  connectionInfo: { ip: string; port: number; token: string };
  onClose?: () => void;
}

export const QRCodeDisplay: React.FC<QRCodeDisplayProps> = ({ connectionInfo, onClose }) => {
  const { primary } = useTheme();
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [error, setError] = useState<string>('');

  useEffect(() => {
    const generateQR = async () => {
      try {
        // Validate connection info
        if (!connectionInfo || !connectionInfo.ip || !connectionInfo.port || !connectionInfo.token) {
          setError('Invalid connection information');
          console.error('Invalid connection info:', connectionInfo);
          return;
        }

        // Use plain text format: ip:port:token
        // This works in both development (Expo Go) and production builds
        // The in-app scanner will handle parsing, not iOS Camera app
        const connectionString = `${connectionInfo.ip}:${connectionInfo.port}:${connectionInfo.token}`;
        console.log('Generating QR code for:', connectionString);
        console.log('Connection info:', { 
          ip: connectionInfo.ip, 
          port: connectionInfo.port, 
          token: connectionInfo.token.substring(0, 10) + '...' 
        });
        
        // Use higher error correction and larger size for better scanning
        const dataUrl = await QRCode.toDataURL(connectionString, {
          width: 225, // Reduced for smaller display
          margin: 3, // Increased margin for better detection
          color: {
            dark: '#000000',
            light: '#FFFFFF',
          },
          errorCorrectionLevel: 'H', // High error correction for better reliability
        });
        
        console.log('QR code generated successfully');
        setQrDataUrl(dataUrl);
      } catch (err) {
        setError('Failed to generate QR code');
        console.error('QR generation error:', err);
      }
    };

    if (connectionInfo) {
      generateQR();
    }
  }, [connectionInfo]);

  if (error) {
    return (
      <div className="glass-card" style={{ padding: '20px', textAlign: 'center' }}>
        <p style={{ color: 'red' }}>{error}</p>
        {onClose && (
          <button onClick={onClose} style={{ marginTop: '10px', padding: '8px 16px' }}>
            Close
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="qr-code-modal">
      <div className="qr-code-modal-content">
        <h3 style={{ marginBottom: '16px', color: primary, fontSize: '18px', fontWeight: '600' }}>Scan to Sync with Your Mobile App</h3>
        {qrDataUrl ? (
          <div style={{ 
            width: '180px', 
            height: '180px', 
            margin: '0 auto 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'white',
            padding: '12px',
            borderRadius: '12px',
            boxShadow: '0 4px 20px rgba(0, 0, 0, 0.3)',
          }}>
            <img 
              src={qrDataUrl} 
              alt="QR Code" 
              style={{ 
                width: '100%', 
                height: '100%', 
                objectFit: 'contain',
              }} 
            />
          </div>
        ) : (
          <div style={{ 
            width: '180px', 
            height: '180px', 
            margin: '0 auto 16px',
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'center',
            backgroundColor: 'rgba(255, 255, 255, 0.1)',
            borderRadius: '12px',
          }}>
            <p style={{ color: 'rgba(255, 255, 255, 0.7)' }}>Generating QR code...</p>
          </div>
        )}
        <p style={{ marginBottom: '8px', fontSize: '13px', opacity: 0.8, color: 'rgba(255, 255, 255, 0.9)' }}>
          Make sure both devices are on the same WiFi network
        </p>
        <p style={{ marginBottom: '16px', fontSize: '12px', opacity: 0.7, color: 'rgba(255, 255, 255, 0.8)', fontStyle: 'italic' }}>
          Use the in-app scanner in the memo app, not the iOS Camera app
        </p>
        {onClose && (
          <button 
            onClick={onClose} 
            style={{ 
              padding: '10px 24px',
              background: 'transparent',
              border: `2px solid ${primary}`,
              color: primary,
              borderRadius: '8px',
              cursor: 'pointer',
              fontSize: '14px',
              fontWeight: '500',
              transition: 'all 0.2s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = primary;
              e.currentTarget.style.color = '#000';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = primary;
            }}
          >
            Close
          </button>
        )}
      </div>
    </div>
  );
};

