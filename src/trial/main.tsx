import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import { TrialBoardView } from './TrialBoardView.js';
import '@xyflow/react/dist/style.css';
import './trial.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ReactFlowProvider><TrialBoardView /></ReactFlowProvider>
  </StrictMode>
);
