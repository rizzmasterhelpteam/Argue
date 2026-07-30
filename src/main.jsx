import React from 'react';
import { createRoot } from 'react-dom/client';
import { AuthenticatedApp } from './app/AuthenticatedApp';
import { AuthProvider } from './context/AuthContext';
import './styles.css';

const rootElement = document.getElementById('root');

if (rootElement) {
  createRoot(rootElement).render(<AuthProvider><AuthenticatedApp /></AuthProvider>);
}
