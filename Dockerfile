FROM nginx:alpine

COPY . /usr/share/nginx/html

EXPOSE 80

CMD ["/bin/sh", "-c", \
  "sed -i \"s|WEBHOOK_URL_PLACEHOLDER|${WEBHOOK_URL}|g\" /usr/share/nginx/html/controller/Main.controller.js && \
   sed -i \"s|API_URL_PLACEHOLDER|${API_URL}|g\" /usr/share/nginx/html/controller/Main.controller.js && \
   nginx -g 'daemon off;'"]
