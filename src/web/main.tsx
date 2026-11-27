import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import App from './App.js';
import { AppErrorBoundary } from './AppErrorBoundary.js';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode><AppErrorBoundary><ReactFlowProvider><App /></ReactFlowProvider></AppErrorBoundary></StrictMode>
);
