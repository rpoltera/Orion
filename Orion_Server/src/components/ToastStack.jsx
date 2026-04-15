import React from 'react';
import { useApp } from '../contexts/AppContext';
import { CheckCircle, XCircle, Info } from 'lucide-react';

const icons = {
  success: <CheckCircle size={16} color="#10b981" />,
  error:   <XCircle size={16} color="#ef4444" />,
  info:    <Info size={16} color="var(--accent)" />,
};

export default function ToastStack() {
  const { notifications } = useApp();
  return (
    <div className="toast-stack">
      {notifications.map(n => (
        <div key={n.id} className={`toast ${n.type}`}>
          {icons[n.type] || icons.info}
          <span style={{ fontSize: 13 }}>{n.message}</span>
        </div>
      ))}
    </div>
  );
}
