"""Noodle's local helper. Requests contain paths and metadata, never editor text."""
import json
import sys
from storage import locked, state_home
import documents
import files
import search
import tasks
import review
import assets


def dispatch(action, request):
    home = state_home(request)
    if action == 'search':
        return search.search(request, home)
    if action == 'search_cancel':
        search.generation(request, home)
        return {'cancelled': True}
    with locked(home):
        if action == 'asset_preview': return assets.preview(request, home)
        if action == 'review_hunks': return review.hunks(request, home)
        if action == 'review_apply': return review.apply(request, home)
        if action == 'review_compare': return review.compare(request)
        if action == 'review_pr': return review.pr(request, home)
        if action == 'review_log': return review.failure_log(request, home)
        if action.startswith('task'):
            return tasks.handle(action, request, home)
        if action.startswith('document_'):
            return documents.handle(action, request, home)
        if action == 'file_prepare':
            return files.prepare(request, home)
        if action == 'file_apply':
            return files.apply(request, home)
        if action == 'file_restore':
            return files.restore(request, home)
        raise ValueError('Unknown workspace operation')


if __name__ == '__main__':
    try:
        result = dispatch(sys.argv[1], json.loads(sys.argv[2]))
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=False))
        sys.exit(1)
