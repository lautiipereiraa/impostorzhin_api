# ImpostorZhin - API (Backend)

Este es el servidor del juego ImpostorZhin, construido con Node.js, Express y Socket.io.

## Requisitos Previos

- [Node.js](https://nodejs.org/) (versión 16 o superior)
- npm (incluido con Node.js)

## Instalación y Ejecución Local

1. Instala las dependencias:
   ```bash
   npm install
   ```

2. Ejecuta el servidor en modo desarrollo (se reinicia automáticamente con nodemon):
   ```bash
   npm run dev
   ```

3. El servidor correrá por defecto en el puerto `3001` (http://localhost:3001).

## Despliegue (Production)

Para desplegar en servicios como **Render** o **Railway**:
- Comando de instalación: `npm install`
- Comando de inicio: `npm start`
- Puerto: El servidor usará automáticamente el puerto definido en la variable de entorno `PORT` o el `3001` por defecto.
