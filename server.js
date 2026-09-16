'use strict';

const path = require('path');
const express = require('express');

const { createRouter } = require('./src/routes');

function createApp(options = {}) {
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use('/static', express.static(path.join(__dirname, 'public')));

  app.use(createRouter(options));

  app.use((req, res) => {
    res.status(404).render('layout', {
      view: 'error',
      title: 'Page not found',
      status: 404,
      heading: 'Page not found',
      detail: 'The page you were looking for does not exist.'
    });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).render('layout', {
      view: 'error',
      title: 'Something went wrong',
      status: 500,
      heading: 'Something went wrong',
      detail: 'Please try again in a moment.'
    });
  });

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => {
    console.log(`Simple CRM listening on port ${port}`);
  });
}

module.exports = { createApp };
