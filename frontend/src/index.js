import React from 'react';
import ReactDOM from 'react-dom/client';
import axios from 'axios';
import { backendApiUrl } from './config';
import App from './App';
import './App.css';

if (backendApiUrl) {
	axios.defaults.baseURL = backendApiUrl;
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);