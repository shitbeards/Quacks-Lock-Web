build:
	- rm consts.js
	echo "export const debug = false\nexport const ws_url = 'wss://quacks-lock.herokuapp.com/ws'\n" > consts.js
	- rm -rf built
	mkdir built
	jspm bundle-sfx --minify app/main built/app.min.js
	node_modules/.bin/html-dist index.html --remove-all --minify --insert app.min.js -o built/index.html
	cp -r resources* built/
	- rm consts.js
	echo "export const debug = true\nexport const ws_url = 'wss://quacks-lock.herokuapp.com/ws'\n" > consts.js
deploy:
	aws s3 sync built/ s3://com-shitbeards-quackslock
