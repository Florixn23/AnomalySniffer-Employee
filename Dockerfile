FROM nginx:alpine

COPY . /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["/bin/sh", "-c", \
  "sed -i \"s|WEBHOOK_URL_PLACEHOLDER|${WEBHOOK_URL}|g\" /usr/share/nginx/html/controller/Main.controller.js && \
   sed -i \"s|API_URL_PLACEHOLDER|/api|g\" /usr/share/nginx/html/controller/Main.controller.js && \
   nginx -g 'daemon off;'"]
