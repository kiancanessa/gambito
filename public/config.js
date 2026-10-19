// Configuración del cliente (se carga antes que la aplicación).
//
// Si sirves el cliente desde el MISMO servidor de Gambito (npm start, Docker, Render...), no cambies nada.
// Si lo publicas aparte, por ejemplo en Vercel, pon aquí la URL del servidor y añade el origen del cliente
// a la variable ALLOWED_ORIGINS del servidor.
const BACKEND_URL = 'https://gambito.onrender.com';

// El servidor remoto solo se usa en alojamientos estáticos de Vercel; en local y en el propio servidor se usa el mismo origen.
window.GAMBITO_API = location.hostname.endsWith('.vercel.app') ? BACKEND_URL : '';

// Interruptores de funciones en desarrollo (se pueden activar con ?flag=nombre en la URL).
// lobby: lobby competitivo (Fase 1). Ponlo en false para volver a la pantalla de inicio anterior.
window.GAMBITO_FLAGS = { lobby: true };
