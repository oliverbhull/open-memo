import React, { useState, useRef, useEffect } from 'react';
import '../styles/glass.css';
import { hexToHsl, hslToHex } from '../utils/colorUtils';
import { logger } from '../utils/logger';

interface ColorPickerProps {
  value: string;
  onChange: (color: string) => void;
}

export const ColorPicker: React.FC<ColorPickerProps> = ({ value, onChange }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [hue, setHue] = useState(0);
  const [saturation, setSaturation] = useState(100);
  const [lightness, setLightness] = useState(50);
  const pickerRef = useRef<HTMLDivElement>(null);
  const saturationRef = useRef<HTMLDivElement>(null);

  const isUpdatingRef = useRef(false);

  // Initialize from hex value (only when value changes externally)
  useEffect(() => {
    if (!isUpdatingRef.current && value) {
      try {
        const [h, s, l] = hexToHsl(value);
        setHue(h);
        setSaturation(s);
        setLightness(l);
      } catch (error) {
        logger.error('Failed to parse hex color:', value, error);
      }
    }
  }, [value]);

  // Update hex when HSL changes (only if we're updating internally)
  useEffect(() => {
    if (isUpdatingRef.current) {
      const newHex = hslToHex(hue, saturation, lightness);
      const normalizedValue = value.toLowerCase();
      const normalizedNewHex = newHex.toLowerCase();
      if (normalizedNewHex !== normalizedValue) {
        onChange(newHex);
      }
      isUpdatingRef.current = false;
    }
  }, [hue, saturation, lightness]);

  const handleSaturationMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    isUpdatingRef.current = true;
    if (!saturationRef.current) return;
    const rect = saturationRef.current.getBoundingClientRect();
    const updateColor = (clientX: number, clientY: number) => {
      const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      setSaturation(Math.round(x * 100));
      setLightness(Math.round((1 - y) * 100));
    };
    
    updateColor(e.clientX, e.clientY);
    
    const handleMouseMove = (moveEvent: MouseEvent) => {
      moveEvent.preventDefault();
      updateColor(moveEvent.clientX, moveEvent.clientY);
    };
    
    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  const handleHueMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    isUpdatingRef.current = true;
    const rect = e.currentTarget.getBoundingClientRect();
    const updateHue = (clientX: number) => {
      const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      setHue(Math.round(x * 360));
    };
    
    updateHue(e.clientX);
    
    const handleMouseMove = (moveEvent: MouseEvent) => {
      moveEvent.preventDefault();
      updateHue(moveEvent.clientX);
    };
    
    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  const hueColor = `hsl(${hue}, 100%, 50%)`;
  const currentColor = `hsl(${hue}, ${saturation}%, ${lightness}%)`;

  return (
    <div className="custom-color-picker" ref={pickerRef}>
      <button
        className="color-picker-trigger"
        onClick={() => setIsOpen(!isOpen)}
        style={{ background: value }}
        type="button"
      />
      
      {isOpen && (
        <div className="color-picker-popup">
          <div
            ref={saturationRef}
            className="color-picker-saturation"
            style={{
              background: `linear-gradient(to right, #fff 0%, ${hueColor} 100%), linear-gradient(to bottom, transparent 0%, #000 100%)`,
            }}
            onMouseDown={handleSaturationMouseDown}
          >
            <div
              className="color-picker-selector"
              style={{
                left: `${saturation}%`,
                top: `${100 - lightness}%`,
              }}
            />
          </div>
          
          <div className="color-picker-hue" onMouseDown={handleHueMouseDown}>
            <div
              className="color-picker-hue-selector"
              style={{ left: `${(hue / 360) * 100}%` }}
            />
          </div>
          
          <div className="color-picker-preview" style={{ background: currentColor }} />
          
          <div className="color-picker-inputs">
            <input
              type="text"
              value={value.toUpperCase()}
              onChange={(e) => {
                const hex = e.target.value;
                if (/^#[0-9A-Fa-f]{6}$/.test(hex)) {
                  isUpdatingRef.current = false; // External change
                  onChange(hex);
                }
              }}
              className="color-picker-hex-input"
              placeholder="#000000"
            />
          </div>
        </div>
      )}
    </div>
  );
};


