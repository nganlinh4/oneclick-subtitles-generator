import React, { useState } from 'react';
import LiquidGlass from './LiquidGlass';

/**
 * Demo component showcasing various LiquidGlass configurations
 * This can be used for testing and as a reference for implementation
 */
const LiquidGlassDemo = () => {
  const [clickCount, setClickCount] = useState(0);
  const [dragPosition, setDragPosition] = useState({ x: 100, y: 100 });

  return (
    <div style={{ 
      padding: '20px', 
      minHeight: '100vh', 
      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      position: 'relative'
    }}>
      <h1 style={{ color: 'white', marginBottom: '30px' }}>LiquidGlass Component Demo</h1>
      
      {/* Basic Examples */}
      <div style={{ marginBottom: '40px' }}>
        <h2 style={{ color: 'white', marginBottom: '20px' }}>Basic Examples</h2>
        
        {/* Small interactive button */}
        <LiquidGlass
          width={100}
          height={40}
          className="content-center interactive theme-primary"
          onClick={() => setClickCount(count => count + 1)}
          style={{ marginRight: '20px', marginBottom: '20px' }}
        >
          <span style={{ color: 'white', fontSize: '14px', fontWeight: '600' }}>
            Clicks: {clickCount}
          </span>
        </LiquidGlass>

        {/* Medium glass panel */}
        <LiquidGlass
          width={150}
          height={80}
          className="content-center theme-secondary"
          style={{ marginRight: '20px', marginBottom: '20px' }}
        >
          <div style={{ textAlign: 'center', color: 'white' }}>
            <div style={{ fontSize: '16px', fontWeight: '600' }}>Glass Panel</div>
            <div style={{ fontSize: '12px', opacity: 0.8 }}>Static Content</div>
          </div>
        </LiquidGlass>

        {/* Large draggable glass */}
        <LiquidGlass
          width={200}
          height={120}
          position="absolute"
          left={`${dragPosition.x}px`}
          top={`${dragPosition.y}px`}
          draggable={true}
          constrainToViewport={true}
          className="content-center theme-success animate-float"
          onDragEnd={(e) => {
            const rect = e.target.getBoundingClientRect();
            setDragPosition({ x: rect.left, y: rect.top });
          }}
        >
          <div style={{ textAlign: 'center', color: 'white' }}>
            <div style={{ fontSize: '18px', fontWeight: '600' }}>Draggable</div>
            <div style={{ fontSize: '14px', opacity: 0.8 }}>Drag me around!</div>
          </div>
        </LiquidGlass>
      </div>

      {/* Shape Variants */}
      <div style={{ marginBottom: '40px' }}>
        <h2 style={{ color: 'white', marginBottom: '20px' }}>Shape Variants</h2>
        
        <LiquidGlass
          width={80}
          height={80}
          className="content-center shape-circle theme-warning"
          style={{ marginRight: '20px', marginBottom: '20px' }}
        >
          <span style={{ color: 'white', fontSize: '24px' }}>⭐</span>
        </LiquidGlass>

        <LiquidGlass
          width={120}
          height={50}
          className="content-center shape-pill theme-error"
          style={{ marginRight: '20px', marginBottom: '20px' }}
        >
          <span style={{ color: 'white', fontSize: '14px', fontWeight: '600' }}>Pill Shape</span>
        </LiquidGlass>

        <LiquidGlass
          width={100}
          height={100}
          className="content-center shape-square theme-primary"
          style={{ marginRight: '20px', marginBottom: '20px' }}
        >
          <span style={{ color: 'white', fontSize: '14px', fontWeight: '600' }}>Square</span>
        </LiquidGlass>
      </div>

      {/* Animation Examples */}
      <div style={{ marginBottom: '40px' }}>
        <h2 style={{ color: 'white', marginBottom: '20px' }}>Animation Examples</h2>
        
        <LiquidGlass
          width={100}
          height={60}
          className="content-center animate-pulse theme-primary"
          style={{ marginRight: '20px', marginBottom: '20px' }}
        >
          <span style={{ color: 'white', fontSize: '14px', fontWeight: '600' }}>Pulse</span>
        </LiquidGlass>

        <LiquidGlass
          width={100}
          height={60}
          className="content-center animate-glow theme-secondary"
          style={{ marginRight: '20px', marginBottom: '20px' }}
        >
          <span style={{ color: 'white', fontSize: '14px', fontWeight: '600' }}>Glow</span>
        </LiquidGlass>

        <LiquidGlass
          width={60}
          height={60}
          className="content-center animate-rotate shape-circle theme-success"
          style={{ marginRight: '20px', marginBottom: '20px' }}
        >
          <span style={{ color: 'white', fontSize: '20px' }}>🔄</span>
        </LiquidGlass>
      </div>

      {/* Intensity Variants */}
      <div style={{ marginBottom: '40px' }}>
        <h2 style={{ color: 'white', marginBottom: '20px' }}>Effect Intensity</h2>
        
        <LiquidGlass
          width={120}
          height={60}
          className="content-center intensity-subtle"
          style={{ marginRight: '20px', marginBottom: '20px' }}
        >
          <span style={{ color: 'white', fontSize: '12px', fontWeight: '600' }}>Subtle</span>
        </LiquidGlass>

        <LiquidGlass
          width={120}
          height={60}
          className="content-center intensity-normal"
          style={{ marginRight: '20px', marginBottom: '20px' }}
        >
          <span style={{ color: 'white', fontSize: '12px', fontWeight: '600' }}>Normal</span>
        </LiquidGlass>

        <LiquidGlass
          width={120}
          height={60}
          className="content-center intensity-strong"
          style={{ marginRight: '20px', marginBottom: '20px' }}
        >
          <span style={{ color: 'white', fontSize: '12px', fontWeight: '600' }}>Strong</span>
        </LiquidGlass>

        <LiquidGlass
          width={120}
          height={60}
          className="content-center intensity-extreme"
          style={{ marginRight: '20px', marginBottom: '20px' }}
        >
          <span style={{ color: 'white', fontSize: '12px', fontWeight: '600' }}>Extreme</span>
        </LiquidGlass>
      </div>

      {/* Custom Effect Parameters */}
      <div style={{ marginBottom: '40px' }}>
        <h2 style={{ color: 'white', marginBottom: '20px' }}>Custom Effects</h2>
        
        <LiquidGlass
          width={150}
          height={80}
          effectIntensity={2.0}
          effectRadius={0.8}
          effectWidth={0.4}
          effectHeight={0.3}
          updateOnMouseMove={true}
          className="content-center theme-warning"
          style={{ marginRight: '20px', marginBottom: '20px' }}
        >
          <span style={{ color: 'white', fontSize: '14px', fontWeight: '600' }}>
            Mouse Reactive
          </span>
        </LiquidGlass>

        <LiquidGlass
          width={150}
          height={80}
          effectIntensity={0.3}
          effectRadius={0.2}
          effectWidth={0.1}
          effectHeight={0.1}
          className="content-center theme-error"
          style={{ marginRight: '20px', marginBottom: '20px' }}
        >
          <span style={{ color: 'white', fontSize: '14px', fontWeight: '600' }}>
            Minimal Effect
          </span>
        </LiquidGlass>
      </div>

      {/* Usage Instructions */}
      <div style={{ 
        background: 'rgba(255, 255, 255, 0.1)', 
        padding: '20px', 
        borderRadius: '12px',
        color: 'white',
        marginTop: '40px'
      }}>
        <h3>Usage Instructions:</h3>
        <ul style={{ lineHeight: '1.6' }}>
          <li>Click the "Clicks" button to test interactivity</li>
          <li>Drag the green "Draggable" panel around the screen</li>
          <li>Hover over elements to see hover effects</li>
          <li>Move your mouse over the "Mouse Reactive" panel</li>
          <li>Observe different animation and intensity effects</li>
        </ul>
      </div>
    </div>
  );
};

export default LiquidGlassDemo;
